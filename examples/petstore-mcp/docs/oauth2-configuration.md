# OAuth2 Configuration

This API uses OAuth2 for authentication. The MCP server can authenticate in the following ways:

1. **Using a pre-acquired token**: set `OAUTH_TOKEN_<SCHEME>` to a token you already obtained. This works for every flow.

## Environment Variables

### petstore_auth

**Configuration Variables:**

- `OAUTH_TOKEN_PETSTORE_AUTH`: Pre-acquired OAuth token (required). The server cannot fetch tokens for this scheme's flows, so obtain one with your OAuth client and set it here.

**Implicit Flow:**

- Authorization URL: `https://petstore3.swagger.io/oauth/authorize`

**Available Scopes:**

- `write:pets`: modify pets in your account
- `read:pets`: read your pets

