# Interviewer Chatbot

AI mock-interview coach: pick a track (behavioral or technical), answer questions by typing or speaking, get structured rubric feedback per answer and a session summary at the end.

Standalone web app, iframe-embeddable in membership platforms (Podia, Circle, etc.). LLM via OpenRouter (model swappable, default `deepseek/deepseek-v4-flash`); spoken input via the browser's Web Speech API. Zero npm dependencies.

See [SPEC.md](SPEC.md) for the full build spec.

## Run

```
cp .env.example .env   # add your OPENROUTER_API_KEY
npm start              # http://localhost:3000  (PORT to override)
```

## Status

Working locally, verified end-to-end in a browser. Not yet deployed.
