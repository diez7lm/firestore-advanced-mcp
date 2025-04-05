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

// Fonction pour déterminer si une chaîne a la structure d'une référence à un document
function looksLikeDocumentReference(value) {
  if (typeof value !== 'string') return false;
  
  // Les références ont généralement un format comme "collection/document" ou "collection/document/collection/document"
  const parts = value.split('/');
  
  // Une référence valide doit avoir au moins 2 parties et un nombre pair de parties
  return parts.length >= 2;
}

// Fonction pour convertir une valeur en type Firestore approprié
function convertValueToFirestoreType(value, type) {
  if (value === null || value === undefined) return null;
  
  switch (type) {
    case 'timestamp':
      if (typeof value === 'string') {
        return admin.firestore.Timestamp.fromDate(new Date(value));
      } else if (value instanceof Date) {
        return admin.firestore.Timestamp.fromDate(value);
      } else if (typeof value === 'number') {
        return admin.firestore.Timestamp.fromMillis(value);
      }
      break;
      
    case 'geopoint':
      if (typeof value === 'object' && 'latitude' in value && 'longitude' in value) {
        return new admin.firestore.GeoPoint(value.latitude, value.longitude);
      }
      break;
      
    case 'reference':
      if (typeof value === 'string') {
        return admin.firestore().doc(value);
      } else if (value && typeof value === 'object' && value.path) {
        return admin.firestore().doc(value.path);
      }
      break;
      
    case 'array':
      if (Array.isArray(value)) {
        return value;
      } else if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch (e) {
          // Si ce n'est pas un JSON valide, le convertir en tableau singleton
          return [value];
        }
      }
      return [value]; // Convertir en tableau singleton par défaut
      
    case 'map':
    case 'object':
      if (typeof value === 'object' && value !== null) {
        return value;
      } else if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch (e) {
          // Si ce n'est pas un JSON valide, retourner un objet avec une propriété value
          return { value };
        }
      }
      return { value }; // Convertir en objet simple par défaut
      
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lowercased = value.toLowerCase();
        if (lowercased === 'true') return true;
        if (lowercased === 'false') return false;
      }
      return Boolean(value);
      
    case 'number':
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const num = Number(value);
        if (!isNaN(num)) return num;
      }
      break;
      
    case 'string':
      return String(value);
      
    case 'null':
      return null;
      
    default:
      // Si le type n'est pas spécifié ou n'est pas reconnu, essayons de deviner
      if (value instanceof Date) {
        return admin.firestore.Timestamp.fromDate(value);
      } 
      
      if (typeof value === 'object' && value !== null) {
        if ('latitude' in value && 'longitude' in value) {
          return new admin.firestore.GeoPoint(value.latitude, value.longitude);
        }
        
        if (value._isDocumentReference || (value.path && typeof value.path === 'string')) {
          return admin.firestore().doc(value.path);
        }
      }
      
      // Si c'est une chaîne qui semble être une référence à un document
      if (typeof value === 'string' && looksLikeDocumentReference(value)) {
        return admin.firestore().doc(value);
      }
      
      // Par défaut, retourner la valeur telle quelle
      return value;
  }
  
  // Si la conversion a échoué, retourner la valeur telle quelle
  return value;
}

// Fonction pour analyser une erreur Firestore et détecter les problèmes d'index manquants
async function handleMissingIndexError(error, collection, options = {}) {
  const errorMessage = error.message || '';
  
  // Détection des messages d'erreur liés aux index manquants
  if (errorMessage.includes('requires an index') || 
      errorMessage.includes('no matching index found') ||
      errorMessage.includes('needs index')) {
    
    // Extraire l'URL pour créer l'index à partir du message d'erreur
    const indexUrlMatch = errorMessage.match(/https:\/\/console\.firebase\.google\.com\/[^\s]+/);
    const createUrl = indexUrlMatch ? indexUrlMatch[0] : null;
    
    // Type de requête qui a échoué
    const queryType = options.collectionGroup ? 'Collection Group Query' : 'Collection Query';
    
    // Instructions personnalisées pour créer l'index
    let instructions = '';
    if (createUrl) {
      instructions = `Pour résoudre ce problème : 
1. Visitez ${createUrl}
2. Connectez-vous à votre projet Firebase
3. Cliquez sur "Créer index" pour générer l'index manquant`;
    } else {
      instructions = `Pour résoudre ce problème :
1. Accédez à la console Firebase : https://console.firebase.google.com/
2. Sélectionnez votre projet
3. Dans le menu de gauche, cliquez sur "Firestore Database"
4. Allez dans l'onglet "Indexes"
5. Cliquez sur "Add Index" et configurez l'index pour la collection "${collection}"`;
    }
    
    return {
      type: 'missing_index',
      message: `Cette requête complexe nécessite un index spécial. ${errorMessage}`,
      collection,
      queryType,
      createUrl,
      instructions
    };
  }
  
  // Si l'erreur n'est pas liée à un index manquant
  return {
    type: 'other_error',
    message: errorMessage,
    collection
  };
}