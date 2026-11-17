import OpenAI from "openai";
import "dotenv/config";

// ai& is OpenAI-compatible. We just swap the baseURL.
// Override with AIAND_BASE_URL (e.g. https://openrouter.ai/api/v1 to run the original HN demo).
export const BASE_URL = process.env.AIAND_BASE_URL ?? "https://api.aiand.com/v1";

export const client = new OpenAI({
  baseURL: BASE_URL,
  apiKey: process.env.AIAND_API_KEY ?? process.env.OPENROUTER_API_KEY,
});
