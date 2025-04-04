/**
 * Test script for Firestore Advanced MCP
 * 
 * Ce script vérifie les fonctionnalités avancées du MCP Firestore.
 */

import { McpClient } from '@modelcontextprotocol/sdk/client/mcp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

async function runTests() {
  // Lancer le serveur MCP
  const server = spawn('node', ['./index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  });

  // Créer un client MCP
  const client = new McpClient(new StdioClientTransport(server.stdin, server.stdout));
  
  // Attendre que le serveur soit prêt
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  try {
    console.log("Exécution des tests pour Firestore Advanced MCP...");
    
    // Tester les références Firestore
    console.log("\n1. Test des références Firestore");
    const refResult = await client.call('firestore_special_data_types', {
      collection: 'test_collection',
      id: 'test_document',
      operation: 'set',
      data: {
        fields: [
          {
            fieldPath: 'userRef',
            type: 'reference',
            value: 'users/user123'
          }
        ],
        additionalData: {
          name: 'Test Document'
        }
      },
      merge: true
    });
    console.log("Résultat:", refResult.content[0].text ? "OK" : "ÉCHEC");

    // Tester la configuration TTL
    console.log("\n2. Test de la configuration TTL");
    const ttlResult = await client.call('firestore_set_ttl', {
      collection: 'test_collection',
      id: 'test_document',
      expiresIn: 86400000,
      fieldName: 'expires_at'
    });
    console.log("Résultat:", ttlResult.content[0].text ? "OK" : "ÉCHEC");

    // Tester les requêtes sur groupes de collections avec filtres
    console.log("\n3. Test des requêtes sur groupes de collections");
    const groupQueryResult = await client.call('firestore_collection_group_query', {
      collectionId: 'test_collection',
      filters: [
        {
          field: 'name',
          operator: '==',
          value: 'Test Document'
        }
      ],
      limit: 10
    });
    console.log("Résultat:", groupQueryResult.content[0].text ? "OK" : "ÉCHEC");

    console.log("\nTous les tests sont terminés!");

  } catch (error) {
    console.error("Erreur lors des tests:", error);
  } finally {
    // Fermer le serveur
    server.kill();
  }
}

runTests();