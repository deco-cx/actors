import { ACTOR_ID_HEADER_NAME, ACTOR_ID_QS_NAME } from "../stubutil.ts";

export interface ActorLocator {
  id: string;
  name?: string;
  method?: string;
}

const ACTORS_API_SEGMENT = "actors";
const ACTORS_INVOKE_API_SEGMENT = "invoke";

export const invokePathname = (locator: ActorLocator): string | null => {
  if (!locator.name || !locator.method) {
    return null;
  }
  return `/${ACTORS_API_SEGMENT}/${locator.name}/${ACTORS_INVOKE_API_SEGMENT}/${locator.method}?${ACTOR_ID_QS_NAME}=${locator.id}`;
};
const parseActorInvokeApi = (pathname: string) => {
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

/**
 * Retrieves the actor ID from the request.
 */
export const locateActor = (
  reqOrUrl: URL | Request,
  req?: Request,
): ActorLocator | null => {
  if (reqOrUrl instanceof Request) {
    return locateActor(new URL(reqOrUrl.url), reqOrUrl);
  }
  if (reqOrUrl instanceof URL && req instanceof Request) {
    const id = req.headers.get(ACTOR_ID_HEADER_NAME) ??
      reqOrUrl.searchParams.get(ACTOR_ID_QS_NAME);
    const nameAndMethod: { actorName?: string; methodName?: string } =
      parseActorInvokeApi(reqOrUrl.pathname) ?? {};
    if (!id) {
      return null;
    }
    return {
      id,
      name: nameAndMethod.actorName,
      method: nameAndMethod.methodName,
    };
  }
  return null;
};
