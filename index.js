#!/usr/bin/env node

/**
 * Firestore Advanced MCP Server
 * 
 * Un serveur MCP complet pour Firebase Firestore avec support pour:
 * - Toutes les opérations CRUD avec traitement avancé des données
 * - Requêtes composées et filtres multiples
 * - Opérations atomiques et transactions
 * - Gestion TTL et index
 * - Conversion automatique des types Firestore
 * - Détection intelligente des erreurs d'index manquants
 * 
 * Par diez7lm (c) 2025
 * Licence MIT
 */
import admin from 'firebase-admin';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const { firestore } = admin;
const { parse: parseJSON } = JSON;

// Performance optimization: Document cache system
const documentCache = {
  cache: new Map(),
  ttl: 60000, // 60 seconds TTL by default
  maxSize: 500, // Maximum cache size
  hitCount: 0,
  missCount: 0,
  
  // Get a document from cache or null if not present/expired
  get(key) {
    if (!this.cache.has(key)) {
      this.missCount++;
      return null;
    }
    
    const { data, timestamp } = this.cache.get(key);
    const now = Date.now();
    
    // Check if cache entry has expired
    if (now - timestamp > this.ttl) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }
    
    this.hitCount++;
    return data;
  },
  
  // Set a document in cache
  set(key, data) {
    // If cache is at max size, remove oldest entry
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  },
  
  // Invalidate a cache entry
  invalidate(key) {
    this.cache.delete(key);
  },
  
  // Clear entire cache
  clear() {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
  },
  
  // Get cache statistics
  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRatio = totalRequests > 0 ? this.hitCount / totalRequests : 0;
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRatio: hitRatio.toFixed(2)
    };
  }
};

// Initialize Firebase app if not already initialized
let serviceAccountPath = process.env.SERVICE_ACCOUNT_KEY_PATH;

if (!serviceAccountPath) {
  console.error('SERVICE_ACCOUNT_KEY_PATH environment variable not set.');
  process.exit(1);
}

try {
  const serviceAccount = parseJSON(fs.readFileSync(serviceAccountPath, 'utf8'));
  
  const firebaseConfig = {
    credential: admin.credential.cert(serviceAccount),
  };
  
  if (admin.apps.length === 0) {
    admin.initializeApp(firebaseConfig);
  }
} catch (error) {
  console.error(`Error initializing Firebase: ${error.message}`);
  process.exit(1);
}

/**
 * Extracts and returns the project ID from the service account file.
 */
function getProjectId(serviceAccountPath) {
  try {
    const serviceAccount = parseJSON(fs.readFileSync(serviceAccountPath, 'utf8'));
    return serviceAccount.project_id;
  } catch (error) {
    console.error(`Error reading project ID: ${error.message}`);
    return null;
  }
}

// Helper function to convert Firebase Timestamps to ISO strings recursively
// avec protection contre les objets circulaires et limitation de profondeur
function convertTimestampsToISO(data, visitedObjects = new WeakMap(), depth = 0, maxDepth = 20) {
  // Protection contre les objets null ou undefined
  
  // Détection des références circulaires et cas de base
  if (data === null || data === undefined || typeof data !== 'object') {
    return data;
  }
  
  if (visitedObjects.has(data)) {
    return "[Référence circulaire]";
  }
  
  // Marquer cet objet comme visité
  visitedObjects.set(data, true);
  
  // Traiter les types Firestore spécifiques
  if (data instanceof admin.firestore.Timestamp) {
    return data.toDate().toISOString();
  }
  
  if (data instanceof admin.firestore.GeoPoint) {
    return { latitude: data.latitude, longitude: data.longitude };
  }
  
  // Amélioration du traitement des références
  if (data instanceof admin.firestore.DocumentReference) {
    return { 
      type: 'reference',
      path: data.path,
      id: data.id,
      collection: data.parent.id,
      _isDocumentReference: true
    };
  }
  
  // Vérifier si l'objet est convertible en référence
  if (data && typeof data === 'object' && data._isDocumentReference) {
    return data; // Déjà converti
  }
  
  // Vérifier si l'objet a une propriété 'path' qui semble être une référence
  if (data && typeof data === 'object' && data.path && typeof data.path === 'string' && 
      data.path.includes('/') && !Array.isArray(data)) {
    const pathParts = data.path.split('/');
    // Si le chemin a un format de référence document (collection/document/...)
    if (pathParts.length >= 2) {
      const id = pathParts[pathParts.length - 1];
      const collection = pathParts[pathParts.length - 2];
      
      return {
        type: 'reference',
        path: data.path,
        id: id,
        collection: collection,
        _isDocumentReference: true
      };
    }
  }
  
  // Traiter les tableaux récursivement
  if (Array.isArray(data)) {
    return data.map(item => convertTimestampsToISO(item, visitedObjects, depth + 1, maxDepth));
  }
  
  // Traiter les objets récursivement
  if (typeof data === 'object') {
    const result = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        result[key] = convertTimestampsToISO(data[key], visitedObjects, depth + 1, maxDepth);
      }
    }
    return result;
  }
  
  return data;
}