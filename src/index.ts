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

seedDemoData().then(() => {
  app.listen(PORT, () => {
    console.log(`Doctor-app server listening on http://localhost:${PORT}`);
    console.log(`Demo logins -> doctor/password123, assistant/password123`);
  });
});
