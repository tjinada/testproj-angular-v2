# ActiveGate DQL endpoint discovery - Round 2
# Replace <your-token> with the actual Dynatrace token.

# Test 1: Grail query via environment API (newer path)
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/grail/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1"}'

# Test 2: Environment API v2 query execute
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/query:execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1","defaultTimeframeStart":null,"defaultTimeframeEnd":null}'

# Test 3: Platform storage without /v1/
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/platform/storage/query:execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1","defaultTimeframeStart":null,"defaultTimeframeEnd":null}'

# Test 4: Try Bearer auth instead of Api-Token on platform path
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/e/zuy24864/platform/storage/query/v1/query:execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Api-Token <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1","defaultTimeframeStart":null,"defaultTimeframeEnd":null}'

# Test 5: Without /e/environment-id prefix
curl -vk -X POST \
  "http://dynakube-activegate.dynatrace/platform/storage/query/v1/query:execute" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"query":"fetch spans, from: -5m | limit 1","defaultTimeframeStart":null,"defaultTimeframeEnd":null}'

# Test 6: Check what the API base actually lists
curl -vk "http://dynakube-activegate.dynatrace/e/zuy24864/api/v2/" \
  -H "Authorization: Api-Token <your-token>"

# Test 7: Check API v1 base
curl -vk "http://dynakube-activegate.dynatrace/e/zuy24864/api/v1/" \
  -H "Authorization: Api-Token <your-token>"
