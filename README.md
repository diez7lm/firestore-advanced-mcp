[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/diez7lm-firestore-advanced-mcp-badge.png)](https://mseep.ai/app/diez7lm-firestore-advanced-mcp)

# 🔥 Firestore Advanced MCP

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen)

Serveur MCP (Model Context Protocol) avancé pour Firebase Firestore, permettant aux grands modèles de langage comme Claude d'interagir de façon complète avec vos bases de données Firebase.

## ✨ Fonctionnalités

- 📝 **Support complet de Firestore** : CRUD, requêtes composées, filtres multiples
- ⚡ **Opérations avancées** : Transactions, opérations atomiques, mise à jour par lot
- 🔄 **Types de données spéciaux** : GeoPoint, références de documents, horodatages
- ⏱️ **Gestion TTL** : Configuration du Time-To-Live pour les documents
- 🔍 **Détection intelligente des index manquants** : Instructions automatiques pour créer les index nécessaires
- 🎯 **Recherche avancée** : Requêtes sur groupes de collections, filtres complexes

## 📋 Prérequis

- Node.js >= 16.0.0
- Un projet Firebase avec Firestore activé
- Une clé de compte de service Firebase (fichier JSON)

## 🚀 Installation

### Via npm

```bash
npm install -g firestore-advanced-mcp
```

### Via GitHub

```bash
git clone https://github.com/diez7lm/firestore-advanced-mcp.git
cd firestore-advanced-mcp
npm install
```

## 🔧 Configuration

1. **Obtenir votre clé de compte de service Firebase** :
   - Allez sur la [console Firebase](https://console.firebase.google.com/)
   - Sélectionnez votre projet
   - Paramètres du projet > Comptes de service
   - Générez une nouvelle clé privée et téléchargez le fichier JSON

2. **Définir la variable d'environnement** :

```bash
export SERVICE_ACCOUNT_KEY_PATH="/chemin/vers/votre/serviceAccountKey.json"
```

## 🖥️ Utilisation

### Avec npm global

```bash
SERVICE_ACCOUNT_KEY_PATH="/chemin/vers/votre/serviceAccountKey.json" firestore-advanced-mcp
```

### Avec npx

```bash
SERVICE_ACCOUNT_KEY_PATH="/chemin/vers/votre/serviceAccountKey.json" npx firestore-advanced-mcp
```

### Depuis le répertoire cloné

```bash
SERVICE_ACCOUNT_KEY_PATH="/chemin/vers/votre/serviceAccountKey.json" node index.js
```

### Configuration dans Claude

Pour utiliser ce serveur MCP avec Claude, ajoutez la configuration suivante dans votre fichier `claude_desktop_config.json` :

```json
"firebase-mcp": {
  "command": "npx",
  "args": ["firestore-advanced-mcp"],
  "env": {
    "SERVICE_ACCOUNT_KEY_PATH": "/chemin/vers/votre/serviceAccountKey.json"
  }
}
```

Ou pour une version installée localement :

```json
"firebase-mcp": {
  "command": "node",
  "args": ["/chemin/vers/firestore-advanced-mcp/index.js"],
  "env": {
    "SERVICE_ACCOUNT_KEY_PATH": "/chemin/vers/votre/serviceAccountKey.json"
  }
}
```

## 🛠️ Outils disponibles

Le serveur fournit les outils suivants à Claude :

### Opérations de base
- `firestore_get` - Récupérer un document
- `firestore_create` - Créer un nouveau document
- `firestore_update` - Mettre à jour un document existant
- `firestore_delete` - Supprimer un document
- `firestore_query` - Exécuter une requête avec filtres
- `firestore_list_collections` - Lister les collections disponibles

### Requêtes avancées
- `firestore_collection_group_query` - Requête sur groupes de collections
- `firestore_composite_query` - Requête avec filtres et tris multiples
- `firestore_count_documents` - Compter les documents sans tout récupérer

### Types spéciaux et fonctionnalités avancées
- `firestore_special_data_types` - Gérer les GeoPoints et références
- `firestore_set_ttl` - Configurer l'expiration automatique des documents
- `firestore_transaction` - Exécuter une transaction composée de multiples opérations
- `firestore_batch` - Exécuter des opérations par lot
- `firestore_field_operations` - Opérations atomiques (increment, arrayUnion, etc.)
- `firestore_full_text_search` - Recherche textuelle dans les documents

## 📝 Exemples

### Récupérer un document
```json
{
  "collection": "users",
  "id": "user123"
}
```

### Créer un document avec référence à un autre document
```json
{
  "collection": "orders",
  "data": {
    "product": "Laptop",
    "price": 999.99,
    "fields": [
      {
        "fieldPath": "user",
        "type": "reference",
        "value": "users/user123"
      }
    ]
  }
}
```

### Configurer TTL sur un document
```json
{
  "collection": "temporaryData",
  "id": "session123",
  "expiresIn": 86400000,
  "fieldName": "expires_at"
}
```

### Exécuter une requête avec filtres multiples
```json
{
  "collection": "products",
  "filters": [
    {
      "field": "category",
      "operator": "==",
      "value": "electronics"
    },
    {
      "field": "price",
      "operator": "<",
      "value": 1000
    }
  ],
  "orderBy": {
    "field": "price",
    "direction": "asc"
  },
  "limit": 10
}
```

## 📄 Licence

Ce projet est sous licence MIT - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 👨🏽‍💻 Auteur

- Diez7lm

## 🙏 Remerciements

- [Anthropic](https://www.anthropic.com/) pour Claude et le Model Context Protocol
- [Firebase](https://firebase.google.com/) pour Firestore et les outils de développement

## 🦾 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à soumettre une pull request ou à signaler des problèmes via les issues GitHub.

## 📚 Documentation supplémentaire

Pour plus d'informations sur l'utilisation de Firestore avec Firebase, consultez la [documentation officielle de Firebase](https://firebase.google.com/docs/firestore).

Pour en savoir plus sur le Model Context Protocol (MCP) et son utilisation avec Claude, consultez la [documentation d'Anthropic](https://docs.anthropic.com/claude/docs/model-context-protocol).
