---
name: ian-xiaohei-illustrations
description: Generate Ian-style article illustration assets. Used when asked to design or generate "absurd", "Xiaohei", "hand-drawn", "article illustration", "body text image", "illustration shot list", "remove title / edit illustration" for articles, posts, blogs, Notion docs, workflows, methodologies, processes, structures, states, metaphors, or views; uses yellow Xiaohei IP, pure white hand-drawn canvas, orange/blue English annotations, clean and imaginative visual style by default.
---

# Ian Xiaohei Absurd Article Illustrations

## Core Positioning

Design and generate 16:9 horizontal article inline illustrations. The goal is not commercial illustration, PPT infographics, or cute cartoons, but turning key article judgments, processes, structures, states, or metaphors into clean, absurd, creative, and readable hand-drawn explanatory sketches.

The default visual IP character is "Xiaohei": filled yellow body (#FFCA54) with thin black outline, black dot eyes, thin legs, blank expression, performing an absurd yet coherent system task. Xiaohei MUST perform the core action in the image and never just stand around as decoration.

## Read These References First

Read according to task needs; do not load all context at once:

- `references/style-dna.md`: Style DNA, colors, typography, and forbidden patterns.
- `references/xiaohei-ip.md`: Xiaohei IP appearance, personality, action library, and rules.
- `references/composition-patterns.md`: Composition structures, original metaphor methods, and anti-copy rules.
- `references/prompt-template.md`: Standalone image generation prompt template.
- `references/qa-checklist.md`: Post-generation inspection and iteration rules.
- `assets/examples/`: Low-frequency visual reference only; do not include in default prompt generation path or directly copy composition/props.

## Workflow

### 1. Digest Content

Read the provided article, link, Notion page, Markdown file, or screenshot first. Extract:

- The core thesis/judgment
- Which paragraphs mark cognitive transitions
- Which concepts are best explained visually
- Which sections should remain text-only

Do not illustrate evenly. Prioritize "cognitive anchors", such as: core judgments, double breakpoints, input-output loops, branching/routing, before/after contrast, one-source-multiple-uses, handoff paths, common pitfalls, and character state changes.

### 2. Formulate Illustration Strategy

If the user asks to "analyze illustrations / think about image placement", provide a shot list first. For each image, specify:

- Placement (after which paragraph)
- Image theme
- Core message
- Structure type
- Xiaohei's action
- Suggested elements
- Suggested English annotations

Default to 4-8 images (1-3 for short posts; max 9 for long posts). Keep it concise to avoid turning the post into an image catalog.

### 3. Generate Standalone Images

When explicitly asked to "generate / create / output images", generate each image without stopping to wait. Do not combine multiple images into one frame.

Each image explains exactly ONE core structure. Prompts must include:

- 16:9 horizontal aspect ratio
- Pure white background
- Black hand-drawn line art
- Sparse orange/blue English handwritten annotations (never red)
- Generous white space (at least 35%)
- Yellow Xiaohei (#FFCA54) as the main active subject
- Strictly forbid PPT graphics, commercial illustrations, childish/cute art, complex technical architectures, or top-left titles

Do not copy past case compositions unless explicitly requested. Always invent a fresh, absurd, yet coherent metaphor for the current article.

### 4. Inspect & Iterate

Check against `references/qa-checklist.md`. Re-generate or edit if:

- Xiaohei is purely decorative
- The composition is cluttered
- Looks like a PPT slide or formal flowchart
- Excessive text or illegible handwriting
- Contains top-left titles (e.g. "Workflow Diagram / System Architecture")
- Style is too cute, childish, or rigid
- Background is not clean pure white

### 5. Save & Deliver

Save final images to:

```text
blog/src/assets/media/<post-slug>/
```

Name sequentially:

```text
01-topic-name.png
02-topic-name.png
```

Update `blog/src/_data/media.json` with status `"ready"`. Preserve original generated assets unless requested to overwrite.

## Output Tone

Keep pre-generation strategies brief and precise. Post-generation delivery should report:

- Number of images generated
- Purpose of each image
- Saved asset file paths
- Recommended core vs optional images

Do not over-explain style theory; let the illustrations speak for themselves.

---

## Local Overrides (Munder Difflin Blog)

These local rules take precedence whenever this skill runs in this repository:

1. **Xiaohei is YELLOW.** Xiaohei's body is ALWAYS filled with Munder Difflin accent yellow **#FFCA54** with a thin black hand-drawn outline. Eyes are two small BLACK dots.
2. Annotations are hand-written in **English**.
3. Annotation colors: **orange, blue, and yellow only — NEVER red** (site-wide no-red rule).
4. Output images go to `blog/src/assets/media/<post-slug>/` and entries are recorded in `blog/src/_data/media.json` (status set to `"ready"`).
5. Aspect 16:9, pure white background, one concept per image.

Attribution: "Ian Xiaohei Illustrations" by Ian (https://github.com/helloianneo), MIT — see LICENSE and NOTICE.md.
