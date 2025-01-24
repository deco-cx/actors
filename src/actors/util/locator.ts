import { ACTORS_API_SEGMENT, ACTORS_INVOKE_API_SEGMENT } from "../runtime.ts";
import { ACTOR_ID_HEADER_NAME, ACTOR_ID_QS_NAME } from "../stubutil.ts";

export interface ActorLocator {
  id: string | null;
  name: string;
  method: string;
}

/**
 * Retrieves the actor ID from the request.
 */
export const getActorLocator = (
  reqOrUrl: URL | Request,
  req?: Request,
): ActorLocator | null => {
  if (reqOrUrl instanceof Request) {
    return getActorLocator(new URL(reqOrUrl.url), reqOrUrl);
  }
  if (reqOrUrl instanceof URL && req instanceof Request) {
    const id = req.headers.get(ACTOR_ID_HEADER_NAME) ??
      reqOrUrl.searchParams.get(ACTOR_ID_QS_NAME);

    const maybeActorNameAndMethod = actorNameAndMethod(reqOrUrl.pathname);
    if (!maybeActorNameAndMethod) {
      return null;
    }
    return {
      id,
      name: maybeActorNameAndMethod.actorName,
      method: maybeActorNameAndMethod.methodName,
    };
  }
  return null;
};

/**
 * Parses Actor pathname to extract actor name and method name.
 */
const actorNameAndMethod = (pathname: string) => {
  if (!pathname) {
    return null;
  }
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const [_, actorsApiSegment, actorName, invokeApiSegment, methodName] =
    normalized.split("/");
  if (
    actorsApiSegment !== ACTORS_API_SEGMENT ||
    invokeApiSegment !== ACTORS_INVOKE_API_SEGMENT
  ) {
    return null;
  }
  return { actorName, methodName };
};
