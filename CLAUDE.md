# vencord-voice-panel

## Coding guidelines

Derived from Andrej Karpathy's notes on LLM coding pitfalls
(https://github.com/multica-ai/andrej-karpathy-skills). These bias toward caution
over speed; use judgement on trivial tasks.

1. **Think before coding.** State assumptions explicitly. If a request has more
   than one plausible interpretation, name them and ask — do not pick silently. If
   a simpler approach exists, say so before building the complex one.
2. **Simplicity first.** Minimum code that solves the problem. No speculative
   features, no abstractions for single-use code, no configurability nobody asked
   for. If it is 200 lines and could be 50, rewrite it.
3. **Surgical changes.** Touch only what the task requires. Match the existing
   style, do not reformat or "improve" adjacent code, do not refactor what is not
   broken, and do not delete pre-existing dead code — mention it instead. Every
   changed line should trace to the request.
4. **Goal-driven execution.** Turn the task into a verifiable goal before starting
   ("add validation" → "tests for invalid input, then make them pass"). For
   multi-step work, state a short plan with a verification step per item, and loop
   until each check passes.
