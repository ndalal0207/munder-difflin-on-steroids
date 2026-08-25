/**
 * Vision Bridge & Vision Subagent Architecture for Munder Difflin:
 * Enables text-only coding models (e.g. OpenCode with text-only models, Llama 3 via Ollama, Codex)
 * to receive high-fidelity visual context when users paste or upload images/screenshots.
 *
 * It routes image attachments to a Vision Model (local Ollama VLM like gemma3 / llama3.2-vision / qwen2-vl,
 * or OmniRoute/OpenAI vision endpoint), converting the image into a detailed textual description
 * [IMAGE VISION ANALYSIS (filename)]: ... so text-only agents never crash or reject image payloads.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

export interface VisionBridgeOptions {
  ollamaUrl?: string;
  visionModel?: string;
  apiKey?: string;
  baseUrl?: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.heic', '.tiff']);

/** Check if a file path is a supported image format. */
export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase());
}

/**
 * Route an image through the Vision Bridge (Ollama local VLM, OmniRoute, or metadata fallback)
 * to generate a structured textual description for text-only coding models.
 */
export async function describeImage(
  imagePath: string,
  opts: VisionBridgeOptions = {}
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!existsSync(imagePath)) {
    return { ok: false, error: `Image file not found: ${imagePath}` };
  }

  if (!isImageFile(imagePath)) {
    return { ok: false, error: `File is not an image: ${basename(imagePath)}` };
  }

  const filename = basename(imagePath);
  const ext = extname(imagePath).toLowerCase().slice(1) || 'png';
  const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  // Read base64
  let base64Data = '';
  try {
    const rawBuffer = readFileSync(imagePath);
    base64Data = rawBuffer.toString('base64');
  } catch (e) {
    return { ok: false, error: `Could not read image file: ${String(e)}` };
  }

  const ollamaUrl = opts.ollamaUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const preferredModels = [
    opts.visionModel || process.env.VISION_MODEL,
    'qwen2.5vl:3b',
    'gemma3:4b',
    'llama3.2-vision',
    'gemma3',
    'qwen2.5-vl',
    'llava'
  ].filter(Boolean) as string[];

  // 1. Try Local Ollama VLM (100% Free & Local on Apple Silicon M1 16GB)
  let activeModel = preferredModels[0];
  try {
    const tagsRes = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (tagsRes.ok) {
      const tagsData = (await tagsRes.json()) as { models?: Array<{ name: string }> };
      const installed = new Set((tagsData.models || []).map((m) => m.name.toLowerCase()));

      for (const candidate of preferredModels) {
        if (installed.has(candidate.toLowerCase()) || Array.from(installed).some((i) => i.includes(candidate.toLowerCase()))) {
          activeModel = candidate;
          break;
        }
      }
    }
  } catch {
    /* tags check failed, fallback to candidate */
  }

  const structuredPrompt =
    'You are a UI reverse-engineering vision model. Analyze the provided UI screenshot precisely for a frontend development AI agent.\n\n' +
    'Identify:\n' +
    '1. OVERALL LAYOUT & COMPONENT HIERARCHY\n' +
    '2. EXACT COMPONENTS (buttons, inputs, sliders, icons, navigation, text)\n' +
    '3. COLORS (primary, background, accents, borders)\n' +
    '4. TYPOGRAPHY (font style, weight, relative size, alignment)\n' +
    '5. SPACING & PADDING (alignment, gaps, margins)\n' +
    '6. BORDERS, SHADOWS & RADIUS\n' +
    '7. UX ISSUES, ALIGNMENT ERRORS & VISIBLE ERROR MESSAGES\n' +
    '8. EXACT REPRODUCTION INSTRUCTIONS for a React/HTML/CSS developer.\n\n' +
    'If any detail is uncertain, explicitly state "uncertain" instead of guessing.';

  // Try /api/chat endpoint (Ollama standard for vision models like qwen2.5vl:3b)
  try {
    const chatRes = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
        messages: [
          {
            role: 'user',
            content: structuredPrompt,
            images: [base64Data]
          }
        ],
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (chatRes.ok) {
      const data = (await chatRes.json()) as { message?: { content?: string } };
      if (data.message?.content && data.message.content.trim()) {
        const visionText = `[LOCAL VISION ANALYSIS via ${activeModel} (${filename})]:\n${data.message.content.trim()}`;
        return { ok: true, text: visionText };
      }
    }
  } catch {
    /* fallback to /api/generate below */
  }

  // Fallback /api/generate endpoint
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
        prompt: structuredPrompt,
        images: [base64Data],
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (res.ok) {
      const data = (await res.json()) as { response?: string };
      if (data.response && data.response.trim()) {
        const visionText = `[LOCAL VISION ANALYSIS via ${activeModel} (${filename})]:\n${data.response.trim()}`;
        return { ok: true, text: visionText };
      }
    }
  } catch {
    /* Ollama local VLM not reachable — fall back to OpenAI/OmniRoute vision or metadata */
  }

  // 2. Try OpenAI / OmniRoute vision API if apiKey/baseUrl provided
  if (opts.apiKey && opts.baseUrl) {
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`
        },
        body: JSON.stringify({
          model: opts.visionModel || 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe this image in precise detail for a software engineering AI agent. Detail all UI elements, layout, code snippets, and error messages.'
                },
                {
                  type: 'image_url',
                  image_url: { url: `data:${mimeType};base64,${base64Data}` }
                }
              ]
            }
          ]
        }),
        signal: AbortSignal.timeout(10000)
      });

      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const desc = data.choices?.[0]?.message?.content?.trim();
        if (desc) {
          return { ok: true, text: `[IMAGE VISION ANALYSIS (${filename})]:\n${desc}` };
        }
      }
    } catch {
      /* fallback */
    }
  }

  // 3. Metadata Fallback (guaranteed response)
  const sizeKb = Math.round((base64Data.length * 0.75) / 1024);
  const fallbackText = `[IMAGE ATTACHMENT (${filename})]: ${mimeType} image, ~${sizeKb}KB. (No local VLM active at ${ollamaUrl}; start Ollama with 'ollama run ${activeModel}' or configure a vision model endpoint for visual analysis).`;
  return { ok: true, text: fallbackText };
}
