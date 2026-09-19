import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { verifyAdminToken, AdminAuthNotConfiguredError } from "../services/adminAuth";

/**
 * Gate for administrative endpoints.
 *
 * Every route behind this can move money, expose customer data, or reconfigure
 * the store. Before this existed the entire admin surface was reachable by
 * anyone who knew a URL — refunds, database repointing, backup restore and the
 * provider secrets among them.
 *
 * The token arrives as `Authorization: Bearer <token>`, minted by
 * POST /api/customers/admin-login. A header is used rather than a cookie because
 * the frontend sends no credentials today and nothing sets `credentials:'include'`,
 * so a cookie scheme would need every call site changed before any of them worked.
 */

export interface AdminRequest extends Request {
  admin?: { email: string };
}

export function requireAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  let payload: ReturnType<typeof verifyAdminToken>;
  try {
    payload = verifyAdminToken(token);
  } catch (err) {
    if (err instanceof AdminAuthNotConfiguredError) {
      // A deployment fault, not a rejected visitor. Said plainly so it is not
      // mistaken for a wrong password, and still refused — an unconfigured
      // secret must never mean "let everyone through".
      console.error("[Admin Auth] Refusing admin request:", err.message);
      return res.status(503).json({
        error: "Admin authentication is not configured on this server.",
        code: "ADMIN_AUTH_NOT_CONFIGURED"
      });
    }
    throw err;
  }

  if (!payload) {
    return res.status(401).json({
      error: "Administrator authentication required.",
      code: "ADMIN_AUTH_REQUIRED"
    });
  }

  req.admin = { email: payload.sub };
  next();
}

/**
 * Gate for scheduled jobs.
 *
 * The Vercel crons charge cards, reconcile payments and sync Royal Mail, and
 * were reachable by anyone over GET. Vercel sends `Authorization: Bearer
 * $CRON_SECRET` when CRON_SECRET is set in the project, so the same header
 * serves both; an admin token is also accepted so these can still be run by hand
 * from the dashboard.
 *
 * If CRON_SECRET is unset the job is refused rather than run, so a forgotten
 * environment variable fails visibly instead of leaving the endpoint open.
 */
export function requireCronOrAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const cronSecret = process.env.CRON_SECRET || "";

  if (cronSecret && presented) {
    const a = Buffer.from(presented);
    const b = Buffer.from(cronSecret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }

  // Fall back to an admin token so the same endpoints stay usable from the
  // dashboard's manual "run now" controls.
  try {
    if (verifyAdminToken(presented)) return next();
  } catch (err) {
    if (!(err instanceof AdminAuthNotConfiguredError)) throw err;
  }

  if (!cronSecret) {
    console.error("[Cron Auth] CRON_SECRET is not set — refusing scheduled job request.");
    return res.status(503).json({
      error: "Scheduled job authentication is not configured on this server.",
      code: "CRON_SECRET_NOT_CONFIGURED"
    });
  }

  return res.status(401).json({
    error: "Scheduled job authentication required.",
    code: "CRON_AUTH_REQUIRED"
  });
}
