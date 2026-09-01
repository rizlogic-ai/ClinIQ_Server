import jwt from "jsonwebtoken";
import { Role } from "../models/types";

const JWT_SECRET = process.env.JWT_SECRET || "change-this-dev-secret";

export interface TokenPayload {
  sub: string;
  role: Role;
  name: string;
  username: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
