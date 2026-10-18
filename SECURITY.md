# Security Policy

css-lab-mcp loads the pages you point it at in a headless browser and runs JavaScript from those
pages, just like a normal browser would. Only inspect pages you trust, such as your own dev server
or local files.

The MCP server runs locally over stdio and doesn't open network ports. It can read local HTML
files and write PNG screenshots to paths the client gives it.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting
("Report a vulnerability" on the Security tab) on the repository. I'll reply as soon as I can.
