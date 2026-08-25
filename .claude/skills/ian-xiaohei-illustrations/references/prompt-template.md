# Standalone Image Generation Prompt Template

Generate each image individually. Replace placeholders based on the article content. Do not combine multiple images into one frame.

```text
Generate one standalone 16:9 horizontal English article illustration.

Visual DNA:
Pure white background. Minimalist black hand-drawn line art. Slightly wobbly pen lines. Lots of empty white space. Sparse orange/blue handwritten English annotations. Clean absurd product-sketch feeling. No gradients, no shadows, no paper texture, no complex background, no commercial vector style, no PPT infographic look, no cute mascot poster, no children's illustration, no realistic UI.

Recurring IP character required:
Xiaohei, a small solid yellow (#FFCA54) absurd creature with black outline, black dot eyes, tiny thin legs, blank serious expression, slightly uneven hand-drawn body shape. Xiaohei must perform the core conceptual action, not decorate the scene. Make Xiaohei serious, deadpan, and slightly bizarre, not cute.

Theme:
{Article Illustration Topic}

Structure type:
{Structure Type: Workflow / Subsystem / Before-After / Character State / Metaphor / Layers / Route Map / Mini Comic}

Core idea:
{Core message explained by this image}

Composition:
{Specific scene: Xiaohei location, action, main props, information flow}

Suggested elements:
{Element 1} / {Element 2} / {Element 3} / {Element 4}

English handwritten labels:
{Label 1} / {Label 2} / {Label 3} / {Label 4}

Color use:
Black for main line art and outlines. Yellow (#FFCA54) for Xiaohei body fill. Orange for main flow/path/arrows. Blue only for secondary notes or system state. Never use red.

Constraints:
One image explains only one core structure. Keep the main subject around 40%-60% of the canvas. Preserve at least 35% blank white space. Use at most 5-8 short handwritten English labels. Do not write a title in the top-left corner. Do not write the structure type on the image. Do not make it a formal diagram, course slide, or dense explainer. Do not copy prior examples; invent a fresh visual metaphor for this specific article. Clear but not instructional, interesting but not childish, strange but clean.
```

## Image Edit Prompts

Remove Top-Left Title:

```text
Edit the provided image. Remove only the handwritten title "{Text to delete}" and its underline from the top-left corner. Fill that area with the same clean white background, matching the surrounding blank paper. Preserve everything else exactly: characters, labels, paths, line style, composition, aspect ratio, and image quality. Do not add any new text or objects.
```

Enhance Absurdity:

```text
Regenerate this illustration with the same core meaning and simple layout, but make Xiaohei more central to the conceptual action. Xiaohei should be doing the strange work that explains the idea, not standing beside the diagram. Keep it clean, sparse, hand-drawn, and not cute.
```
