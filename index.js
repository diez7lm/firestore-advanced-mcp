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
import { v4 as uuidv4 } from 'uuid';

// Configuration et initialisation
console.error("Initialisation du serveur Firestore Advanced MCP...");

// Récupération du chemin du fichier de clé de service à partir de la variable d'environnement
const serviceAccountKeyPath = process.env.SERVICE_ACCOUNT_KEY_PATH;

if (!serviceAccountKeyPath) {
  console.error("Erreur: Variable d'environnement SERVICE_ACCOUNT_KEY_PATH non définie.");
  console.error("Veuillez définir cette variable avec le chemin vers votre fichier de clé de service Firebase.");
  process.exit(1);
}

// Vérification de l'existence du fichier de clé de service
try {
  fs.accessSync(serviceAccountKeyPath, fs.constants.R_OK);
} catch (error) {
  console.error(`Erreur: Impossible de lire le fichier de clé de service à ${serviceAccountKeyPath}`);
  console.error("Veuillez vérifier que le chemin est correct et que le fichier existe.");
  process.exit(1);
}

// Initialisation de Firebase Admin SDK
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountKeyPath)
  });
  
  console.error("Firebase Admin SDK initialisé avec succès");
} catch (error) {
  console.error("Erreur lors de l'initialisation de Firebase Admin SDK:", error);
  process.exit(1);
}

// Utilitaires de cache pour optimiser les performances
class DocumentCache {
  constructor(ttl = 5 * 60 * 1000) { // 5 minutes par défaut
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    const expiryTime = Date.now() + this.ttl;
    this.cache.set(key, { value, expiryTime });
    return value;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiryTime) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.value;
  }

  invalidate(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    let size = 0;
    let expired = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (Date.now() > entry.expiryTime) {
        expired++;
        this.cache.delete(key);
      } else {
        size++;
      }
    }
    
    return { size, expired };
  }

  setTTL(newTTL) {
    this.ttl = newTTL;
  }
}

// Initialisation du cache de documents
const documentCache = new DocumentCache();
const getCacheKey = (collection, id) => `${collection}/${id}`;

// Fonction utilitaire pour convertir les Timestamps Firestore en ISO strings
function convertTimestampsToISO(data, visitedObjects = new WeakMap(), depth = 0, maxDepth = 20) {
  // Protection contre les boucles infinies
  if (depth > maxDepth) return "[Profondeur maximale atteinte]";
  
  // Valeurs null ou undefined
  if (data === null || data === undefined) return data;
  
  // Détection des références circulaires
  if (typeof data === 'object' && data !== null) {
    if (visitedObjects.has(data)) {
      return "[Référence circulaire]";
    }
    visitedObjects.set(data, true);
  }
  
  // Timestamp Firestore
  if (data && typeof data.toDate === 'function') {
    return data.toDate().toISOString();
  }
  
  // GeoPoint Firestore
  if (data instanceof admin.firestore.GeoPoint) {
    return {
      type: "geopoint",
      latitude: data.latitude,
      longitude: data.longitude
    };
  }
  
  // Reference Firestore
  if (data instanceof admin.firestore.DocumentReference) {
    return {
      type: "reference",
      path: data.path,
      id: data.id
    };
  }
  
  // Arrays
  if (Array.isArray(data)) {
    return data.map(item => convertTimestampsToISO(item, visitedObjects, depth + 1, maxDepth));
  }
  
  // Objects
  if (typeof data === 'object' && data !== null) {
    const result = {};
    
    for (const [key, value] of Object.entries(data)) {
      result[key] = convertTimestampsToISO(value, visitedObjects, depth + 1, maxDepth);
    }
    
    return result;
  }
  
  // Autres types de données (number, string, boolean)
  return data;
}

// Fonction utilitaire pour obtenir l'ID du projet Firebase
function getProjectId() {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountKeyPath, 'utf8'));
    return serviceAccount.project_id;
  } catch (error) {
    return "unknown-project";
  }
}

// Fonction pour gérer les erreurs d'index manquants
async function handleMissingIndexError(error, collection, queryDetails = {}) {
  if (error.code === 'failed-precondition' && error.message.includes('requires an index')) {
    const indexMatch = error.message.match(/https:\/\/console\.firebase\.google\.com\/project\/([^\/]+)\/database\/firestore\/indexes\?create_index=([^\s]+)/);
    
    if (indexMatch) {
      const projectId = indexMatch[1];
      const indexParams = indexMatch[2];
      const createUrl = `https://console.firebase.google.com/project/${projectId}/firestore/indexes?create_index=${indexParams}`;
      
      return {
        type: 'missing_index',
        message: `Cette requête nécessite un index composite qui n'existe pas encore. Veuillez cliquer sur le lien pour le créer.`,
        collection,
        description: `Requête avec ${queryDetails.orderByFields ? 'tri multiple' : 'filtre complexe'}`,
        createUrl,
        projectId,
        indexParams
      };
    }
  }
  
  // Si ce n'est pas une erreur d'index ou si on ne peut pas extraire l'URL
  return {
    type: 'other_error',
    message: error.message,
    code: error.code
  };
}

// Création du serveur MCP
const server = new McpServer(
  new StdioServerTransport(),
  { cliName: "firestore-advanced-mcp" }
);

// ==================== OUTILS FIRESTORE ====================

// Outil pour récupérer un document
server.tool(
  'firestore_get',
  {
    collection: z.string().describe('Nom de la collection'),
    id: z.string().describe('ID du document')
  },
  async ({ collection, id }) => {
    try {
      // Vérifier si le document est dans le cache
      const cacheKey = getCacheKey(collection, id);
      const cachedDoc = documentCache.get(cacheKey);
      
      if (cachedDoc) {
        return {
          content: [{ type: 'text', text: JSON.stringify(cachedDoc) }]
        };
      }
      
      // Récupérer le document depuis Firestore
      const docRef = admin.firestore().collection(collection).doc(id);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        return {
          content: [{ type: 'error', text: `Document ${collection}/${id} non trouvé` }]
        };
      }
      
      // Convertir les timestamps en strings ISO et mettre en cache
      const data = convertTimestampsToISO(doc.data());
      const response = {
        id: doc.id,
        collection,
        data,
        exists: true,
        url: `https://console.firebase.google.com/project/${getProjectId()}/firestore/data/${collection}/${id}`
      };
      
      // Mettre en cache
      documentCache.set(cacheKey, response);
      
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'error', text: error.message }]
      };
    }
  }
);

// Outil pour créer un document
server.tool(
  'firestore_create',
  {
    collection: z.string().describe('Nom de la collection'),
    id: z.string().optional().describe('ID du document (généré automatiquement si non fourni)'),
    data: z.any().describe('Données à enregistrer'),
    merge: z.boolean().optional().describe('Fusionner avec un document existant si true')
  },
  async ({ collection, id, data, merge = false }) => {
    try {
      const docId = id || uuidv4();
      const docRef = admin.firestore().collection(collection).doc(docId);
      
      if (!merge) {
        // Vérifier si le document existe déjà
        const doc = await docRef.get();
        if (doc.exists) {
          return {
            content: [{ type: 'error', text: `Le document ${collection}/${docId} existe déjà. Utilisez merge=true pour mettre à jour.` }]
          };
        }
      }
      
      // Créer ou mettre à jour le document
      await docRef.set(data, { merge });
      
      // Invalider le cache
      const cacheKey = getCacheKey(collection, docId);
      documentCache.invalidate(cacheKey);
      
      // Récupérer le document mis à jour
      const updatedDoc = await docRef.get();
      const responseData = convertTimestampsToISO(updatedDoc.data());
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          id: docId,
          collection,
          data: responseData,
          created: !merge,
          merged: merge,
          url: `https://console.firebase.google.com/project/${getProjectId()}/firestore/data/${collection}/${docId}`
        }) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'error', text: error.message }]
      };
    }
  }
);

// Note: Ce fichier est une version simplifiée du serveur MCP. Le code complet contient les implémentations de:
// - firestore_update - Mettre à jour un document existant
// - firestore_delete - Supprimer un document
// - firestore_query - Exécuter une requête avec filtres
// - firestore_collection_group_query - Requête sur groupes de collections
// - firestore_composite_query - Requête avec filtres et tris multiples
// - firestore_special_data_types - Gérer les types spéciaux (GeoPoint, References)
// - firestore_set_ttl - Configurer l'expiration automatique des documents
// - firestore_transaction - Exécuter des transactions atomiques
// - firestore_batch - Exécuter des opérations par lot
// - firestore_field_operations - Effectuer des opérations atomiques sur les champs
// - firestore_full_text_search - Recherche textuelle dans les documents

// Démarrage du serveur
console.error("Firestore Advanced MCP démarré et prêt à recevoir des commandes!");
server.listen();
