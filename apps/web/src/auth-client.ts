import { createAuthClient } from "better-auth/react";
import { apiOrigin } from "./api-base";

export const authClient = createAuthClient({ baseURL: apiOrigin });
