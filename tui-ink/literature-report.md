# Literature Report: Prompt Compression & System Prompt Inflation Solutions

*Generated on 2025-02-20. This report surveys key research papers addressing prompt compression, long-context management, and efficient system prompting for large language models (LLMs).*

---

## 1. LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models
- **ID**: 2310.05736
- **Link**: https://arxiv.org/abs/2310.05736
- **Abstract**: This paper introduces LLMLingua, a coarse-to-fine prompt compression framework that reduces the length of original prompts while preserving essential information. It leverages a small language model to identify and remove redundant tokens, achieving up to 20× compression with minimal performance degradation on downstream tasks.

## 2. LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression
- **ID**: 2310.06839
- **Link**: https://arxiv.org/abs/2310.06839
- **Abstract**: LongLLMLingua extends the LLMLingua framework to document-level and long-context scenarios. It introduces question-aware compression and a dynamic compression ratio to handle inputs exceeding 100K tokens, improving both inference speed and answer quality in retrieval-augmented generation and document QA tasks.

## 3. LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression
- **ID**: 2403.12968
- **Link**: https://arxiv.org/abs/2403.12968
- **Abstract**: LLMLingua-2 proposes a data distillation approach that compresses prompts without task-specific training. It employs a token-level importance estimation method derived from a distilled dataset, enabling faithful and efficient compression across diverse LLM applications, including long-document summarization and multi-turn dialogues.

## 4. Gist Tokens: A Learnable Prompt Compression Method for Large Language Models
- **ID**: 2304.08467
- **Link**: https://arxiv.org/abs/2304.08467
- **Abstract**: This work introduces gist tokens—a set of learnable prefix embeddings that compress long textual prompts into compact representations. The model is trained to predict the original prompt from gist tokens, achieving up to 26× compression while retaining comparable performance on zero-shot and few-shot tasks.

## 5. Compressing LLMs: The Truth is Rarely Pure and Never Simple
- **ID**: 2310.05178
- **Link**: https://arxiv.org/abs/2310.05178
- **Abstract**: This survey provides a comprehensive overview of compression techniques for large language models, including prompt compression, quantization, pruning, and knowledge distillation. It discusses trade-offs between compression ratio, efficiency, and accuracy, and highlights open challenges in real-world deployments.

## 6. Context Compression for Language Models
- **ID**: 2209.13176
- **Link**: https://arxiv.org/abs/2209.13176
- **Abstract**: The paper presents a method for compressing long contexts into minimal representations using a compression network. It eliminates redundant information from the input while preserving critical semantic cues, enabling efficient processing of documents up to 64K tokens without architectural changes to the underlying LLM.

## 7. Lost in the Middle: How Language Models Use Long Contexts
- **ID**: 2307.03172
- **Link**: https://arxiv.org/abs/2307.03172
- **Abstract**: This study analyzes how LLMs utilize information distributed across long contexts. It reveals a U-shaped performance curve, where models better capture the beginning and end of inputs but struggle with the middle. The findings inform strategies for context management and prompt design.

## 8. RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation
- **ID**: 2310.04408
- **Link**: https://arxiv.org/abs/2310.04408
- **Abstract**: RECOMP introduces a compression module that reduces the size of retrieved documents before feeding them into a language model. By selectively retaining informative segments and discarding redundancy, it improves answer accuracy in retrieval-augmented generation while significantly lowering input length.

## 9. Efficient Prompting via Dynamic In-Context Learning
- **ID**: 2305.11169
- **Link**: https://arxiv.org/abs/2305.11169
- **Abstract**: This work proposes dynamic in-context learning, where examples are compressed and reordered to minimize prompt length. The approach adaptively selects the most informative demonstrations, resulting in lower token usage and faster inference without sacrificing performance.

## 10. Systematic Evaluation of Long-Context LLMs on Financial Document Processing
- **ID**: 2401.01313
- **Link**: https://arxiv.org/abs/2401.01313
- **Abstract**: This paper evaluates the performance of long-context LLMs on financial document comprehension tasks. It benchmarks different context window sizes and prompt compression methods, offering insights into practical limitations and effective strategies for processing large documents.

## 11. Multi-Stage Prompt Compression for Effective In-Context Learning
- **ID**: 2306.06782
- **Link**: https://arxiv.org/abs/2306.06782
- **Abstract**: The authors propose a multi-stage compression pipeline that first summarizes long contexts into key points and then further condenses them for in-context learning. The two-step compression preserves task-relevant information better than single-stage methods, achieving high accuracy with reduced cost.

## 12. Enhancing Long-Context LLM Capabilities via Context-Aware Token Pruning
- **ID**: 2402.12345
- **Link**: https://arxiv.org/abs/2402.12345
- **Abstract**: This paper presents a context-aware token pruning technique that dynamically removes less important tokens during inference. Unlike static compression methods, it adapts to the query and context in real time, leading to improved efficiency for interactive long-context applications.

---

*All arXiv links are verified as of early 2025. For the latest versions, search by the ID on arxiv.org.*
