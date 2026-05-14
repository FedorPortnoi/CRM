# 24-coverage removal plan

Remove test G3 (lines ~207-216):
"G3: POST /api/v1/contacts/import-csv rejects an empty row array (ImportContactsCsvSchema array min(1))"

This is an exact duplicate of 22-coverage G17:
"POST /api/v1/contacts/import-csv with an empty array returns 400 and creates no contacts matching a unique prefix"

After removal: 17 tests remain (G1, G2, G4-G18).
