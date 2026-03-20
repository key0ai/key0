import type { Route, SellerConfig } from "../types/index.js";

export type RouteCatalogEntry = {
	routeId: string;
	method: Route["method"];
	path: string;
	unitAmount?: string;
	description?: string;
	params?: Route["params"];
};

export function listCatalogRoutes(config: SellerConfig): RouteCatalogEntry[] {
	return (config.routes ?? []).map((route) => ({
		routeId: route.routeId,
		method: route.method,
		path: route.path,
		...(route.unitAmount ? { unitAmount: route.unitAmount } : {}),
		...(route.description ? { description: route.description } : {}),
		...(route.params ? { params: route.params } : {}),
	}));
}

export function findCatalogRoute(
	config: SellerConfig,
	routeId: string,
): RouteCatalogEntry | undefined {
	return listCatalogRoutes(config).find((route) => route.routeId === routeId);
}

