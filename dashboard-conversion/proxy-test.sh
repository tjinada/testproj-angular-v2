# Proxy NTLM test for Dynatrace connectivity
# Run this from inside the OpenShift pod terminal to verify proxy auth works with NTLM.
# Replace <password> with the actual proxy password.

curl -v --proxy "http://EBCSWG.bmogc.net:8080" \
  --proxy-user "sa_cdb_devsecops:<password>" \
  --proxy-ntlm \
  "https://bky4ydadx2vdd75wbgjee6c4kzu2l6tc--zuy24864.prod2.apps.dynatrace.com"
