# Portal de acompanhamento de processos

Site com login para clientes acompanharem seus processos.

- `index.html`: o site (dados lidos da planilha via Apps Script).
- `api/atualizar.js`: tarefa diária (6h) que consulta o DataJud, resume com o Gemini e grava na planilha.
- Variáveis na Vercel: `CRON_SECRET`, `GEMINI_API_KEY`.
