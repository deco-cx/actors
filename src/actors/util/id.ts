import { ACTOR_ID_HEADER_NAME, ACTOR_ID_QS_NAME } from "../stubutil.ts";

/**
 * Retrieves the actor ID from the request.
 */
export const actorId = (
  reqOrUrl: URL | Request,
  req?: Request,
): string | null => {
  if (reqOrUrl instanceof Request) {
    return actorId(new URL(reqOrUrl.url), reqOrUrl);
  }
  if (reqOrUrl instanceof URL && req instanceof Request) {
    return req.headers.get(ACTOR_ID_HEADER_NAME) ??
      reqOrUrl.searchParams.get(ACTOR_ID_QS_NAME);
  }
  return null;
};
