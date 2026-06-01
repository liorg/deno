sudo systemctl daemon-reload


curl -m 10 -X POST http://localhost:8765 \
  -H "Content-Type: application/json" \
  -d '{"card_type":"sender","code":"export default async function(payload: unknown){ return { success: true }; }"}'
