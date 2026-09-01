import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { clinicRepository, userRepository } from "../data/postgresStore";
import { signToken } from "../utils/jwt";
import { requireAuth } from "../middleware/auth";

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const { username, password } = parsed.data;

  const user = await userRepository.findByUsername(username);
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  if (!user.isActive) {
    return res.status(403).json({ error: "This account has been deactivated." });
  }
  const clinic = await clinicRepository.findById(user.clinicId);
  if (clinic && !clinic.isActive) {
    return res.status(403).json({ error: "This clinic is inactive. Contact your administrator." });
  }

  const token = signToken({
    sub: user.id,
    role: user.role,
    name: user.name,
    username: user.username,
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role },
  });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
