Quickstart
Call DeepSeek: DeepSeek V4.1 Flash through the supported APIs shown above — just set the base URL and your AICredits key.

```
cURL — /v1/chat/completions
Copy
curl https://api.aicredits.in/v1/chat/completions \
  -H "Authorization: Bearer $AICREDITS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'

```

The model name is: deepseek/deepseek-v4.1-flash
