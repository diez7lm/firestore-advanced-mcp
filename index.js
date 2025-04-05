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

// Création du serveur MCP
const server = new McpServer({
  transport: new StdioServerTransport(),
  appName: "Firestore Advanced MCP",
  appDescription: "Serveur MCP avancé pour Firebase Firestore avec support pour toutes les fonctionnalités"
});

// Outil pour récupérer un document
server.tool(
  'firestore_get',
  {
    collection: z.string().describe('Collection dans laquelle se trouve le document'),
    id: z.string().describe('ID du document à récupérer')
  },
  async ({ collection, id }) => {
    try {
      // Vérifier si le document est en cache
      const cacheKey = `${collection}:${id}`;
      const cachedData = documentCache.get(cacheKey);
      
      if (cachedData) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id,
            collection,
            exists: true,
            data: cachedData,
            fromCache: true,
            url: `https://console.firebase.google.com/project/${getProjectId()}/firestore/data/${collection}/${id}`
          }) }]
        };
      }
      
      // Si pas en cache, récupérer depuis Firestore
      const docRef = admin.firestore().collection(collection).doc(id);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id,
            collection,
            exists: false,
            message: `Le document ${collection}/${id} n'existe pas`
          }) }]
        };
      }
      
      // Convertir les timestamps et autres types spéciaux
      const data = convertTimestampsToISO(doc.data());
      
      // Mettre en cache
      documentCache.set(cacheKey, data);
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          id,
          collection,
          exists: true,
          data,
          fromCache: false,
          url: `https://console.firebase.google.com/project/${getProjectId()}/firestore/data/${collection}/${id}`
        }) }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'error', text: errorMessage }]
      };
    }
  }
);

// Outil pour lister les collections disponibles
server.tool(
  'firestore_list_collections',
  {
    // Optional parameters
    parentPath: z.string().optional().describe('Chemin parent pour lister les sous-collections (optionnel)')
  },
  async ({ parentPath }) => {
    try {
      let collectionsRef;
      
      if (parentPath) {
        // If parent path is provided, get subcollections of that document
        collectionsRef = admin.firestore().doc(parentPath);
      } else {
        // If no parent path, get top-level collections
        collectionsRef = admin.firestore();
      }
      
      const collections = await collectionsRef.listCollections();
      const collectionNames = collections.map(col => col.id);
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          collections: collectionNames,
          count: collectionNames.length,
          parentPath: parentPath || null
        }) }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'error', text: errorMessage }]
      };
    }
  }
);

// Outil pour créer un document
server.tool(
  'firestore_create',
  {
    collection: z.string().describe('Collection dans laquelle créer le document'),
    id: z.string().optional().describe('ID du document (généré automatiquement si non fourni)'),
    data: z.any().describe('Données à enregistrer dans le document'),
    merge: z.boolean().default(false).describe('Mode de fusion si le document existe déjà'),
    specialFields: z.array(z.object({
      fieldPath: z.string().describe('Chemin du champ à convertir'),
      type: z.string().describe('Type spécial ("timestamp", "geopoint", "reference", etc.)'),
      value: z.any().describe('Valeur à convertir')
    })).optional().describe('Champs spéciaux à convertir automatiquement')
  },
  async ({ collection, id, data, merge, specialFields }) => {
    try {
      // Créer une référence au document
      let docRef;
      const useProvidedId = id !== undefined && id !== null && id !== '';
      
      if (useProvidedId) {
        docRef = admin.firestore().collection(collection).doc(id);
      } else {
        // Génération automatique de l'ID
        docRef = admin.firestore().collection(collection).doc();
        id = docRef.id;
      }
      
      // Préparer les données à enregistrer
      let documentData = { ...data };
      
      // Traitement des champs spéciaux
      if (specialFields && specialFields.length > 0) {
        specialFields.forEach(field => {
          const { fieldPath, type, value } = field;
          
          // Convertir la valeur selon le type spécifié
          const convertedValue = convertValueToFirestoreType(value, type);
          
          // Traitement des chemins imbriqués (ex: "user.address.city")
          if (fieldPath.includes('.')) {
            const parts = fieldPath.split('.');
            let currentObj = documentData;
            
            // Créer la structure d'objets imbriqués si nécessaire
            for (let i = 0; i < parts.length - 1; i++) {
              const part = parts[i];
              if (!currentObj[part] || typeof currentObj[part] !== 'object') {
                currentObj[part] = {};
              }
              currentObj = currentObj[part];
            }
            
            // Assigner la valeur convertie au dernier niveau
            currentObj[parts[parts.length - 1]] = convertedValue;
          } else {
            // Cas simple sans imbrication
            documentData[fieldPath] = convertedValue;
          }
        });
      }
      
      // Ajouter/fusionner le document
      if (merge) {
        await docRef.set(documentData, { merge: true });
      } else {
        await docRef.set(documentData);
      }
      
      // Invalider le cache pour ce document
      const cacheKey = `${collection}:${id}`;
      documentCache.invalidate(cacheKey);
      
      // Récupérer le document mis à jour
      const updatedDoc = await docRef.get();
      const responseData = convertTimestampsToISO(updatedDoc.data());
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          id,
          collection,
          data: responseData,
          created: !merge,
          merged: merge,
          url: `https://console.firebase.google.com/project/${getProjectId()}/firestore/data/${collection}/${id}`
        }) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'error', text: error.message }]
      };
    }
  }
);

// NEW TOOL: Requêtes sur collections groupées
server.tool(
  'firestore_collection_group_query',
  {
    collectionId: z.string().describe('ID de la collection groupée à requêter'),
    filters: z.array(z.object({
      field: z.string().describe('Champ pour le filtre'),
      operator: z.string().describe('Opérateur de comparaison (==, >, <, >=, <=, !=, array-contains, array-contains-any, in, not-in)'),
      value: z.any().describe('Valeur à comparer')
    })).optional().describe('Filtres à appliquer'),
    limit: z.number().optional().describe('Nombre maximum de résultats à retourner'),
    orderBy: z.array(z.object({
      field: z.string().describe('Champ sur lequel trier'),
      direction: z.enum(['asc', 'desc']).describe('Direction du tri')
    })).optional().describe('Critères de tri')
  },
  async ({ collectionId, filters, limit, orderBy }) => {
    try {
      // Créer une requête sur une collection groupée
      let query = admin.firestore().collectionGroup(collectionId);
      
      // Collection Group Queries avec filtres nécessitent des index spéciaux
      // Voir: https://firebase.google.com/docs/firestore/query-data/queries#collection-group-query
      
      // Appliquer les filtres
      if (filters && filters.length > 0) {
        filters.forEach(filter => {
          const value = filter.value;
          // Pour certains opérateurs (in, array-contains-any), les valeurs doivent être traitées spécialement
          // pour éviter les erreurs de conversion de type
          if ((filter.operator === 'in' || filter.operator === 'array-contains-any') && typeof value === 'string') {
            try {
              // Tenter de parser si la valeur est un JSON (tableau ou objet)
              const parsedValue = JSON.parse(value);
              query = query.where(filter.field, filter.operator, parsedValue);
            } catch (e) {
              // Si ce n'est pas un JSON valide, utiliser la valeur telle quelle
              query = query.where(filter.field, filter.operator, value);
            }
          } else {
            query = query.where(filter.field, filter.operator, value);
          }
        });
      }
      
      // Appliquer les critères de tri
      if (orderBy && orderBy.length > 0) {
        orderBy.forEach(criteria => {
          query = query.orderBy(criteria.field, criteria.direction);
        });
      }
      
      // Appliquer la limite
      if (limit) {
        query = query.limit(limit);
      }
      
      // Exécuter la requête
      const snapshot = await query.get();
      
      // Formater les résultats
      const results = [];
      snapshot.forEach(doc => {
        // Récupérer le chemin complet pour chaque document
        const fullPath = doc.ref.path;
        const pathParts = fullPath.split('/');
        const parentCollection = pathParts.slice(0, -2).join('/');
        
        results.push({
          id: doc.id,
          path: fullPath,
          parentPath: parentCollection ? parentCollection : null,
          data: convertTimestampsToISO(doc.data())
        });
      });
      
      return {
        content: [{ type: 'text', text: JSON.stringify({
          collectionId,
          filteredCount: filters ? filters.length : 0,
          resultCount: results.length,
          results,
          collectionGroupNote: "Les Collection Group Queries avec filtres nécessitent des index composés spéciaux. Si cette requête ne retourne pas les résultats attendus, créez les index appropriés dans la console Firebase."
        }) }]
      };
    } catch (error) {
      // Gestion spéciale des erreurs d'index pour les Collection Group Queries
      const errorHandler = await handleMissingIndexError(error, collectionId, { collectionGroup: true });
      
      if (errorHandler.type === 'missing_index') {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              error: 'INDEX_REQUIRED',
              message: errorHandler.message,
              collectionId: collectionId,
              description: "Collection Group Query avec filtres",
              createUrl: errorHandler.createUrl,
              infoMessage: "Les Collection Group Queries avec filtres nécessitent des index spéciaux. Cliquez sur le lien pour créer l'index nécessaire dans la console Firebase."
            })
          }]
        };
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{ type: 'error', text: errorMessage }]
        };
      }
    }
  }
);

// Démarrage du serveur
console.error("Firestore Advanced MCP démarré et prêt à recevoir des commandes!");
server.listen();