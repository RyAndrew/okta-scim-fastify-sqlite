// ---------------------------------------------------------------------------
// SCIM 2.0 → SQLite bridge — entry point.
//
// The server, authentication, SCIM protocol and audit logging live in
// scim-fastify-core. This repo supplies only the SQLite backend module.
// ---------------------------------------------------------------------------

import { startScimServer } from 'scim-fastify-core';
import { sqliteModule } from './backend';

void startScimServer(sqliteModule);
