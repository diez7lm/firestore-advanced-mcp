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