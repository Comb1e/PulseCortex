import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OwnerIdentity } from "@pulsecortex/domain";
import type { ControllerStore, InteractionRecord } from "./store.js";

interface TokenClaims {
  v: 1;
  kind: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  exp: number;
  nonce: string;
}

export class ActionTokenService {
  constructor(private readonly store: ControllerStore, private readonly signingKey: string) {
    if (Buffer.byteLength(signingKey) < 32) throw new Error("Action signing key must contain at least 32 bytes");
  }

  issue(input: Omit<InteractionRecord, "nonce">): string {
    const claims: TokenClaims = {
      v: 1, kind: input.kind, tenantId: input.tenantId, userId: input.userId, sessionId: input.sessionId,
      turnId: input.turnId, requestId: input.requestId, exp: input.expiresAt, nonce: randomBytes(18).toString("base64url"),
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = this.sign(body);
    this.store.createInteraction({ ...input, nonce: claims.nonce });
    return `${body}.${signature}`;
  }

  consume(token: string, actor: OwnerIdentity, expectedKind?: string, options: { allowExpired?: boolean } = {}): InteractionRecord | null {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const expected = Buffer.from(this.sign(body), "base64url");
    const provided = Buffer.from(signature, "base64url");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    let claims: TokenClaims;
    try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenClaims; }
    catch { return null; }
    if (claims.v !== 1 || (!options.allowExpired && claims.exp < Date.now()) || claims.tenantId !== actor.tenantId || claims.userId !== actor.userId || (expectedKind && claims.kind !== expectedKind)) return null;
    const record = this.store.consumeInteraction(claims.nonce, actor, Date.now(), options.allowExpired === true);
    if (!record || record.kind !== claims.kind || record.sessionId !== claims.sessionId || record.turnId !== claims.turnId || record.requestId !== claims.requestId || record.expiresAt !== claims.exp) return null;
    return record;
  }

  private sign(body: string): string { return createHmac("sha256", this.signingKey).update(body).digest("base64url"); }
}
