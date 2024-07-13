import { appEnvironment } from "./config.ts";
import logger from "./helper/logger";
import { GraphQLClient } from "graphql-request";
import {
  CostCentersByOrganizationId,
  type CostCentersByOrganizationIdQuery,
  MetricTypesByOrganizationId,
  SaveMetrics,
  type SaveMetricsMutation,
  type SaveMetricsMutationVariables,
  type CostCentersByOrganizationIdQueryVariables,
  type MetricTypesByOrganizationIdQueryVariables,
  type MetricTypesByOrganizationIdQuery,
} from "./graphql/generated/graphql.ts";
import {
  type AuthTokens,
  authenticate,
  refreshBearerToken,
} from "./helper/cognito.ts";

let authTokens: AuthTokens;

authTokens = await authenticate();
logger.info(`Authenticated with Jobdone API: ${authTokens.idToken}`);

if (!authTokens.idToken) {
  throw new Error("Failed to authenticate with Jobdone API");
}

export const refreshAuthTokenBearerToken = async () => {
  if (authTokens.refreshToken) {
    const response = await refreshBearerToken(authTokens.refreshToken);
    authTokens.idToken = response.idToken;
    authTokens.accessToken = response.accessToken;
    logger.info(`Refreshed bearer token: ${authTokens.idToken}`);
    
    if (authTokens.idToken) {
      externalGraphqlClient.setHeader("authorization", authTokens.idToken);
      logger.info(`Updated bearer token in externalGraphqlClient: ${authTokens.idToken}`);
    } else {
      logger.error("Unable to refresh bearer token, no idToken found.");
    }
  } else {
    logger.error("No refresh token found.")
  }
};

export const internalGraphqlClient = new GraphQLClient(
  appEnvironment.graphql.endpoint,
  {
    headers: {
      "x-hasura-admin-secret": appEnvironment.graphql.adminSecret,
      organization: appEnvironment.organization.id,
    },
  }
);

export const externalGraphqlClient = new GraphQLClient(
  appEnvironment.graphql.endpoint,
  {
    headers: {
      authorization: authTokens.idToken,
      organization: appEnvironment.organization.id,
    },
  }
);

export const getCostCenters = async (
  variables: CostCentersByOrganizationIdQueryVariables
): Promise<CostCentersByOrganizationIdQuery> => {
  const result: CostCentersByOrganizationIdQuery =
    await internalGraphqlClient.request(CostCentersByOrganizationId, variables);

  logger.info(`Cost centers: ${JSON.stringify(result, null, 2)}`);
  return result;
};

export const getMetricTypes = async (
  variables: MetricTypesByOrganizationIdQueryVariables
): Promise<MetricTypesByOrganizationIdQuery> => {
  const result: MetricTypesByOrganizationIdQuery =
    await internalGraphqlClient.request(MetricTypesByOrganizationId, variables);

  logger.info(`Metric types: ${JSON.stringify(result, null, 2)}`);
  return result;
};

export const UpsertMetrics = async (
  variables: SaveMetricsMutationVariables
): Promise<SaveMetricsMutation> => {
  logger.info(`Saving metrics: ${variables.input?.details.length}`);

  const result = await externalGraphqlClient.request<
    SaveMetricsMutation,
    SaveMetricsMutationVariables
  >(SaveMetrics, variables);

  logger.info(`Saved metrics.`);

  return result;
};
