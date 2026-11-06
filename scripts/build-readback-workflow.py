import json
import sys
import urllib.parse
import uuid
from pathlib import Path

response_path, config_path, workflow_path, output_path, email = sys.argv[1:6]
response = json.load(open(response_path, encoding="utf-8"))
config = json.load(open(config_path, encoding="utf-8"))
workflow = json.load(open(workflow_path, encoding="utf-8"))
if isinstance(workflow, list):
    workflow = workflow[0]

provider = config["crm"]["provider"]
journal_enabled = bool(config.get("journal", {}).get("enabled"))
contact_id = response.get("crm", {}).get("contactId")
external_id = response.get("externalId")
request_id = response.get("requestId")
display_time = response.get("displayTime")

nodes_by_name = {node["name"]: node for node in workflow.get("nodes", [])}


def credential_for(node_name, keys):
    node = nodes_by_name.get(node_name) or {}
    credentials = node.get("credentials") or {}
    for key in keys:
        if credentials.get(key):
            return key, credentials[key]
    return None, None


hubspot_key, hubspot_credential = credential_for("HubSpot Search Contact", ["hubspotAppToken", "hubspotOAuth2Api"])
google_key, google_credential = credential_for("CRM Adapter - Google Sheets", ["googleSheetsOAuth2Api", "googleApi"])
if google_credential is None:
    google_key, google_credential = credential_for("Journal Adapter - Google Sheets", ["googleSheetsOAuth2Api", "googleApi"])

nodes = [{
    "parameters": {},
    "id": str(uuid.uuid4()),
    "name": "Manual Trigger",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 0],
}]
connections_order = ["Manual Trigger"]

def add_http(name, method, url, credential_key, credential, body=None):
    parameters = {
        "method": method,
        "url": url,
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": credential_key,
        "options": {},
    }
    if body is not None:
        parameters.update({
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": json.dumps(body, ensure_ascii=False),
        })
    nodes.append({
        "parameters": parameters,
        "id": str(uuid.uuid4()),
        "name": name,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.5,
        "position": [220, 0],
        "credentials": {credential_key: credential},
    })
    connections_order.append(name)


if provider == "hubspot":
    if not hubspot_credential:
        raise SystemExit("HubSpot credential is not assigned in the active workflow")
    if not contact_id:
        raise SystemExit("HubSpot read-back impossible: response has no contactId")
    add_http(
        "HubSpot Contact By ID",
        "GET",
        f"https://api.hubapi.com/crm/v3/objects/contacts/{contact_id}?properties=email,firstname,lastname,phone",
        hubspot_key,
        hubspot_credential,
    )
    add_http(
        "HubSpot Contact By Email",
        "POST",
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        hubspot_key,
        hubspot_credential,
        {"filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}], "properties": ["email", "firstname", "lastname", "phone"], "limit": 10},
    )

has_leads = False
if provider == "google_sheets" or journal_enabled:
    if not google_credential:
        raise SystemExit("Google Sheets credential is not assigned in the active workflow")
    if journal_enabled:
        journal_sheets_id = config["journal"]["googleSheets"]["spreadsheetId"]
        journal_sheet = config["journal"]["googleSheets"]["sheetName"]
        add_http(
            "Journal Values",
            "GET",
            f"https://sheets.googleapis.com/v4/spreadsheets/{journal_sheets_id}/values/{urllib.parse.quote(journal_sheet + '!A1:ZZ10000')}?majorDimension=ROWS",
            google_key,
            google_credential,
        )
    crm_sheets = (config.get("crm") or {}).get("googleSheets") or {}
    crm_sheets_id = str(crm_sheets.get("spreadsheetId") or "")
    if provider == "google_sheets" or (crm_sheets_id and not crm_sheets_id.startswith("REPLACE_WITH_")):
        if not crm_sheets_id or not crm_sheets.get("leadsSheetName"):
            raise SystemExit("CRM Google Sheets spreadsheetId/leadsSheetName are required for read-back")
        has_leads = True
        leads_range = crm_sheets["leadsSheetName"] + "!A1:ZZ10000"
        add_http(
            "Leads Values",
            "GET",
            f"https://sheets.googleapis.com/v4/spreadsheets/{crm_sheets_id}/values/{urllib.parse.quote(leads_range)}?majorDimension=ROWS",
            google_key,
            google_credential,
        )

constants = {
    "provider": provider,
    "journalEnabled": journal_enabled,
    "contactId": contact_id,
    "email": email,
    "externalId": external_id,
    "requestId": request_id,
    "displayTime": display_time,
    "hasHubspot": provider == "hubspot",
    "crmSheets": provider == "google_sheets",
    "hasLeads": has_leads,
}
assert_code = f'''const errors = [];
const expected = {json.dumps(constants, ensure_ascii=False)};
const headerIndex = (values, name) => (values && values[0] ? values[0].indexOf(name) : -1);
const findRow = (values) => {{
  if (!values || !values[0]) return null;
  const externalIndex = headerIndex(values, 'External ID');
  const requestIndex = headerIndex(values, 'Request ID');
  return values.slice(1).find((row) =>
    (externalIndex >= 0 && String(row[externalIndex]) === String(expected.externalId)) ||
    (requestIndex >= 0 && String(row[requestIndex]) === String(expected.requestId))
  ) || null;
}};
const cell = (values, row, name) => {{
  const index = headerIndex(values, name);
  return index >= 0 && row ? String(row[index]) : null;
}};
if (expected.hasHubspot) {{
  const byId = $('HubSpot Contact By ID').first().json;
  if (String(byId.id) !== String(expected.contactId)) errors.push('HubSpot ID mismatch');
  if (String(byId.properties?.email || '').toLowerCase() !== String(expected.email).toLowerCase()) errors.push('HubSpot email mismatch');
  const search = $('HubSpot Contact By Email').first().json;
  const matches = (search.results || []).filter((item) => String(item.id) === String(expected.contactId));
  if (matches.length !== 1) errors.push('HubSpot email search did not return exactly one matching contact');
}}
if (expected.journalEnabled) {{
  const values = $('Journal Values').first().json.values || [];
  const row = findRow(values);
  if (!row) errors.push('Journal row not found in Journal sheet');
  else {{
    if (expected.hasHubspot && cell(values, row, 'CRM Contact ID') !== String(expected.contactId)) errors.push('Journal CRM Contact ID mismatch');
    if (expected.displayTime && cell(values, row, 'Created At') !== expected.displayTime) errors.push('Journal Created At is not in client timezone');
  }}
}}
if (expected.crmSheets) {{
  const values = $('Leads Values').first().json.values || [];
  const row = findRow(values);
  if (!row) errors.push('CRM row not found in Leads sheet');
  else if (expected.displayTime && cell(values, row, 'Created At') !== expected.displayTime) errors.push('CRM Created At is not in client timezone');
}}
if (expected.hasHubspot) {{
  const values = $('Leads Values').first().json.values || [];
  if (findRow(values)) errors.push('HubSpot lead was also written to Leads sheet');
}}
if (errors.length) throw new Error(errors.join('; '));
return [{{ json: {{ ok: true, provider: expected.provider, journalEnabled: expected.journalEnabled }} }}];'''

nodes.append({
    "parameters": {"mode": "runOnceForAllItems", "jsCode": assert_code},
    "id": str(uuid.uuid4()),
    "name": "Assert Readback",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [440, 0],
})
connections_order.append("Assert Readback")

connections = {}
for source, target in zip(connections_order, connections_order[1:]):
    connections[source] = {"main": [[{"node": target, "type": "main", "index": 0}]]}

workflow_id = f"doctor-readback-{uuid.uuid4().hex[:8]}"
readback = {
    "id": workflow_id,
    "versionId": str(uuid.uuid4()),
    "name": "Doctor Integration Readback",
    "active": False,
    "nodes": nodes,
    "connections": connections,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
}
Path(output_path).write_text(json.dumps(readback, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(workflow_id)
