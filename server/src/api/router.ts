import { Router } from 'express';
import { clientRoutes } from './clientRoutes';
import { frpsPluginRoutes } from './frpsPluginRoutes';

const router = Router();

// Client API routes
router.use(clientRoutes);

// frps plugin callback routes
router.use(frpsPluginRoutes);

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export { router as apiRouter };
