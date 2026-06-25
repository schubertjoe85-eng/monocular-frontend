import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Increase payload limit for large images
app.use(cors());
app.use(express.json({ limit: "35mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 120000, // 2 min timeout on OpenAI calls
  maxRetries: 1,
});

const users = {};
const FREE_RENDER_LIMIT = 5;

function buildPrompt(userPrompt, mode) {
  const base = `
You are Monocular, an architectural visualisation tool.

The uploaded image is the source design. Keep the building recognisable.
Do not invent a different building.

Preserve:
- overall massing
- roof form
- floor count
- window and door positions
- main proportions
- facade rhythm

Improve:
- materials
- lighting
- shadows
- landscape
- sky
- realism
- presentation quality

Do not add text, labels, extra storeys, fantasy forms, or random buildings.
`;

  if (mode === "elevation") {
    return `${base}\nMODE: ELEVATION\nCreate a clean architectural elevation. Orthographic front-facing view. No perspective distortion.\n\nUser brief:\n${userPrompt || "Create a clean architectural elevation."}`;
  }

  if (mode === "site") {
    return `${base}\nMODE: SITE PLACEMENT\nPlace this building into the requested location. Keep the building unchanged. Only adapt landscape, light, vegetation, sky and ground.\n\nUser brief:\n${userPrompt || "Place this building into a realistic site context."}`;
  }

  return `${base}\nMODE: REALISTIC RENDER\nCreate a realistic architectural render. Keep the building geometry close to the source.\n\nUser brief:\n${userPrompt || "Create a realistic architectural render."}`;
}

app.get("/", (req, res) => res.json({ ok: true, name: "Monocular Server", status: "running" }));
app.get("/health", (req, res) => res.json({ ok: true, status: "healthy" }));

app.get("/credits/:userId", (req, res) => {
  const userId = req.params.userId || "guest";
  if (!users[userId]) users[userId] = { rendersRemaining: FREE_RENDER_LIMIT };
  res.json({ ok: true, userId, rendersRemaining: users[userId].rendersRemaining });
});

app.post("/render", async (req, res) => {
  // Set server-side timeout to avoid Render killing the connection
  req.setTimeout(110000);
  res.setTimeout(110000);

  try {
    const {
      prompt,
      imageBase64,
      mode = "render",
      userId = "guest",
      subscriptionActive = false,
      size = "1024x1024",
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "Upload an image first." });
    }

    if (!users[userId]) users[userId] = { rendersRemaining: FREE_RENDER_LIMIT };

    // ✅ Actually enforce the free limit
    if (!subscriptionActive && users[userId].rendersRemaining <= 0) {
      return res.status(403).json({
        ok: false,
        error: "No renders remaining. Please subscribe to continue.",
        rendersRemaining: 0,
      });
    }

    const finalPrompt = buildPrompt(prompt, mode);
    const imageBuffer = Buffer.from(imageBase64, "base64");

    const imageFile = await OpenAI.toFile(imageBuffer, "source.png", {
      type: "image/png",
    });

    const response = await openai.images.edit({
      model: "gpt-image-1",
      image: imageFile,
      prompt: finalPrompt,
      size, // configurable: "1024x1024" | "1536x1024" | "1024x1536"
    });

    const imageBase64Out = response?.data?.[0]?.b64_json;

    if (!imageBase64Out) {
      return res.status(500).json({ ok: false, error: "No image returned from OpenAI." });
    }

    if (!subscriptionActive) {
      users[userId].rendersRemaining -= 1;
    }

    return res.json({
      ok: true,
      image: `data:image/png;base64,${imageBase64Out}`,
      rendersRemaining: users[userId].rendersRemaining,
    });

  } catch (error) {
    console.error("Render error:", error);

    // Give a cleaner timeout message
    if (error.code === "ETIMEDOUT" || error.message?.includes("timeout")) {
      return res.status(504).json({ ok: false, error: "Render timed out. Try a simpler image." });
    }

    return res.status(500).json({ ok: false, error: error.message || "Render failed." });
  }
});

app.listen(PORT, () => console.log(`Monocular server running on port ${PORT}`));
