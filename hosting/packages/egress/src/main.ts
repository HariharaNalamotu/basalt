#!/usr/bin/env node
import { createLog } from '@basalt/host-shared';
import { createEgressProxy } from './proxy.js';

const log = createLog('egress');
const { server } = createEgressProxy({ log });
server.listen(Number(process.env.PORT ?? 3128), '0.0.0.0', () => log.info('listening', { port: Number(process.env.PORT ?? 3128) }));
for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => server.close(() => process.exit(0)));
