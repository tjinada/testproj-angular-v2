# ActiveGate DQL endpoint discovery tests
# Run these from inside the OpenShift pod terminal.
# Replace <your-token> with the actual Dynatrace token.

# Test 1: Check v2 API base
curl -vk "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2"

# Test 2: DQL query endpoint (Api-Token auth)
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/dql/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1"}'

# Test 3: DQL execute endpoint (Api-Token auth)
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/dql/execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1"}'

# Test 4: Same as Test 2 but with Bearer auth
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/dql/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1"}'

# Test 5: List available API endpoints
curl -vk "http://dynakube-activegate.dynatrace/e/zuy24864/api/"
