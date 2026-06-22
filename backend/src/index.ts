import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import authRoutes from './auth/routes';
import sequencesRoutes, { scheduledEmailRouter } from './sequences/routes';
import mailboxesRoutes from './mailboxes/routes';

const app = express();
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/sequences', sequencesRoutes);
app.use('/scheduled-emails', scheduledEmailRouter);
app.use('/mailboxes', mailboxesRoutes);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

app.listen(env.port, () => {
  console.log(`[api] listening on http://localhost:${env.port}`);
});
