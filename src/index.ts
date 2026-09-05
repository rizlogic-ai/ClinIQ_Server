import "dotenv/config";
import express from "express";
import cors from "cors";
import { seedDemoData } from "./data/postgresStore";
import authRoutes from "./routes/auth";
import patientRoutes from "./routes/patients";
import appointmentRoutes from "./routes/appointments";
import invoiceRoutes from "./routes/invoices";
import doctorRoutes from "./routes/doctors";
import adminRoutes from "./routes/admin";
import patientPortalRoutes from "./routes/patientPortal";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/portal", patientPortalRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Last line of defence. Without this an unexpected error (a bad value reaching
// Postgres, say) escapes as an unhandled rejection and takes the process down.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled route error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// A rejection that still escapes should be logged, never fatal.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

seedDemoData().then(() => {
  app.listen(PORT, () => {
    console.log(`ClinIQ server listening on http://localhost:${PORT}`);
  });
});
