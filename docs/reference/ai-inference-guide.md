# Comprehensive Reference: AI Models, Speech-to-Text, and Hardware Mechanics

---

## 1. Gemma 4 Model Overview

- **Developer:** Google DeepMind (Released April 2026, Apache 2.0 open-weights license).
- **Model Tiers:**
  - **E2B & E4B:** Edge-optimized (128K context window).
  - **12B:** Encoder-free unified multimodal (Text + Vision + Audio / ASR, 256K context window).
  - **26B A4B:** Mixture-of-Experts (4B active parameters, 256K context window).
  - **31B:** Frontier-level dense reasoning & coding model (256K context window).
- **Capabilities:** Native chain-of-thought "thinking" mode, tool/function calling for autonomous agents, image/document OCR, and native audio speech recognition (ASR).

---

## 2. Hardware Performance & Inference Comparison

### Hardware Setup

- **MacBook Pro (Apple M3 Pro, 36 GB Unified Memory):**
  - Allocates ~26–28 GB directly to Metal GPU.
  - Runs **Gemma 4 12B** (~40–60 t/s) and **Gemma 4 31B** (~15–20 t/s) fully inside Unified RAM.
  - Best engines: `mlx-whisper` and `whisper.cpp`.
- **`blrofc3` Workstation (AMD Ryzen 9 9950X, 60 GB RAM, NVIDIA RTX 4060 8 GB VRAM):**
  - **GPU (RTX 4060 - 272 GB/s bandwidth):** Runs 12B models / Whisper Turbo at ~35–45 t/s.
  - **CPU (Ryzen 9950X + 60 GB DDR5 RAM - 65 GB/s bandwidth):** Runs 31B models at ~3–5 t/s.

### Speech-to-Text (STT) End-to-End Latency

- **Groq Cloud API:** ~80–150 ms WAN network round-trip + ~30 ms inference = **~110–180 ms total latency**.
- **`blrofc3` GPU (`faster-whisper` / CTranslate2):** ~2–5 ms LAN network + ~25–45 ms GPU compute = **~30–50 ms total latency** (Faster than Groq end-to-end!).

---

## 3. Fine-Tuning & Custom Vocabularies (e.g. `iammvaibhav`)

- **LoRA Adapter:** A small (~30 MB) weight overlay that modifies the base model's sound-to-text mapping without altering the base 1.5 GB weights.
- **Training Time:** Takes **10–15 minutes** on an rented A100 80GB GPU (~$1.50 cost).
- **Zero Latency Penalty:** LoRA weights can be fused permanently into base weights (`model.merge_and_unload()`) before converting to CTranslate2 (FP16/INT8), resulting in zero runtime overhead.

---

## 4. Deep Dive: LLM & GPU Hardware Execution Mechanics

### A. Memory Bandwidth vs. Compute (TFLOPS)

- **FLOP:** Floating Point Operation (1 math calculation).
- **TFLOP:** $10^{12}$ (1 Trillion) FLOPs per second.
- **Why Single-User Inference is Memory-Bound:**
  - To generate 1 word, an 8B model requires **16 Billion FLOPs** of math.
  - An RTX 4060 (30 TFLOPS) can finish 16 Billion FLOPs in **0.5 ms**.
  - However, streaming the 8 GB model from VRAM over a 272 GB/s bus takes **29.4 ms**.
  - **Result:** The GPU compute cores spend 98% of their time idle waiting for data from VRAM.

### B. VRAM vs. SRAM (Registers & Caches)

- **VRAM (8 GB):** The large storage warehouse where weights sit permanently. Cannot perform math.
- **SRAM (50 MB):** The tiny workbench directly inside the CUDA compute cores where actual calculations happen.
- **Matrix Tiling:** Layers larger than 50 MB are sliced into thousands of **64 KB tiles**. The memory controller continuously streams these tiles from VRAM $\rightarrow$ SRAM $\rightarrow$ CUDA Cores.

### C. Input (Prefill) vs. Output (Decode) Pricing

- **Input Tokens (Parallel):** All input tokens are processed in **1 single VRAM read pass** against model weights. Extremely cheap.
- **Output Tokens (Sequential):** Every output token requires streaming the full 8 GB of weights from VRAM through the SRAM workbench all over again. Requires $N$ full VRAM passes for $N$ output tokens (hence 3x–5x more expensive).
- **KV Caching:** Stores pre-calculated Key and Value vectors in GPU VRAM / Host RAM, skipping attention re-computation for repeated prompt tokens.

---

## 5. Inference Engine Cheat-Sheet

| Engine                             | Target Architecture                   | Key Feature                                                        |
| :--------------------------------- | :------------------------------------ | :----------------------------------------------------------------- |
| **GGUF (`llama.cpp` / Ollama)**    | Cross-platform (CPU, Mac Metal, CUDA) | Maximum portability, supports CPU+GPU layer splitting.             |
| **`faster-whisper` (CTranslate2)** | NVIDIA GPUs / x86                     | Fast C++ inference, easy Python integration, INT8/FP16.            |
| **TensorRT-LLM**                   | NVIDIA GPUs only                      | Ahead-of-Time compiled `.engine` binaries. Absolute maximum speed. |
| **`mlx-whisper`**                  | Apple Silicon (M-Series)              | Native Apple MLX framework, tuned for Metal Unified Memory.        |
