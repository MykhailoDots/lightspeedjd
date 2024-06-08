import { appConfig } from "./config.ts";
import logger from "./helper/logger";
import {
  createSrpSession,
  signSrpSession,
  wrapAuthChallenge,
  wrapInitiateAuth,
} from "cognito-srp-helper";
import { GraphQLClient } from "graphql-request";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuthTokens, Metric } from "./types.ts";
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

export const client = new CognitoIdentityProviderClient({
  region: appConfig.jobdone.auth.authRegion,
});
export const internalGraphqlClient = new GraphQLClient(
  appConfig.jobdone.graphql.endpoint,
  {
    headers: {
      "x-hasura-admin-secret": appConfig.jobdone.graphql.adminSecret,
      organization: appConfig.jobdone.organization.id,
    },
  }
);

export const externalGraphqlClient = new GraphQLClient(
  appConfig.jobdone.graphql.endpoint,
  {
    headers: {
      authorization: appConfig.jobdone.auth.bearerToken,
      organization: appConfig.jobdone.organization.id,
    },
  }
);

export const refreshBearerToken = async (
  refreshToken: string
): Promise<AuthTokens> => {
  const command = new InitiateAuthCommand({
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: appConfig.jobdone.auth.userPoolWebClientId,
    AuthParameters: {
      REFRESH_TOKEN: refreshToken,
    },
  });

  try {
    const response = await client.send(command);
    logger.info("Token refresh successful!", response);
    return {
      accessToken: response.AuthenticationResult.AccessToken,
      idToken: response.AuthenticationResult.IdToken,
      refreshToken: response.AuthenticationResult.RefreshToken,
    };
  } catch (error) {
    logger.error("Token refresh failed:", error);
    throw error;
  }
};

export const authenticate = async (): Promise<AuthTokens> => {
  if (appConfig.jobdone.auth.bearerToken) {
    return {
      accessToken: appConfig.jobdone.auth.bearerToken,
      idToken: "",
      refreshToken: "",
    };
  }
  const srpSession = createSrpSession(
    appConfig.jobdone.auth.username,
    appConfig.jobdone.auth.password,
    appConfig.jobdone.auth.userPoolId,
    false
  );
  const command = new InitiateAuthCommand(
    wrapInitiateAuth(srpSession, {
      AuthFlow: "USER_SRP_AUTH",
      ClientId: appConfig.jobdone.auth.userPoolWebClientId,
      AuthParameters: {
        CHALLENGE_NAME: "SRP_A",
        USERNAME: appConfig.jobdone.auth.username,
      },
    })
  );

  try {
    const initiateAuthRes = await client.send(command);
    const signedSrpSession = signSrpSession(srpSession, initiateAuthRes);
    const response = await client.send(
      new RespondToAuthChallengeCommand(
        wrapAuthChallenge(signedSrpSession, {
          ClientId: appConfig.jobdone.auth.userPoolWebClientId,
          ChallengeName: "PASSWORD_VERIFIER",
          ChallengeResponses: {
            USERNAME: appConfig.jobdone.auth.username,
          },
        })
      )
    );

    logger.info(
      `Authentication successful: ${JSON.stringify(response, null, 2)}`
    );
    return {
      accessToken: response.AuthenticationResult.AccessToken,
      idToken: response.AuthenticationResult.IdToken,
      refreshToken: response.AuthenticationResult.RefreshToken,
    };
  } catch (error) {
    logger.error(`Authentication failed: ${JSON.stringify(error, null, 2)}`);
    throw error;
  }
};

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
  logger.info(`Saving metric: ${JSON.stringify(variables, null, 2)}`);

  const result = await externalGraphqlClient.request<
    SaveMetricsMutation,
    SaveMetricsMutationVariables
  >(SaveMetrics, variables);

  logger.info(`Saved metric: ${JSON.stringify(result, null, 2)}`);

  return result;
};
