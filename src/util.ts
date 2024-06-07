import {appConfig} from "./config.ts";
import logger from "./helper/logger";
import {
    createSrpSession,
    signSrpSession,
    wrapAuthChallenge,
    wrapInitiateAuth,
} from "cognito-srp-helper";
import {GraphQLClient} from "graphql-request";
import {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand
} from "@aws-sdk/client-cognito-identity-provider";
import type {AuthTokens, Metric} from "./types.ts";
import {
    CostCenterByOrganizationId, type CostCenterByOrganizationIdQuery,
    type InputMaybe, MetricTypeByOrganizationId, type MetricTypeByOrganizationIdQuery,
    SaveMetric,
    type SaveMetricDetailsInput,
    type SaveMetricMutation,
    type SaveMetricMutationVariables, type Scalars
} from "./graphql/generated/graphql.ts";

export const client = new CognitoIdentityProviderClient({region: appConfig.jobdone.auth.authRegion});
export const internalGraphqlClient = new GraphQLClient(
    appConfig.jobdone.graphql.endpoint,
    {
        headers: {
            "x-hasura-admin-secret": appConfig.jobdone.graphql.adminSecret,
            organization: appConfig.jobdone.organization.id,
        },
    }
);

export const externalGraphqlClient = new GraphQLClient(appConfig.jobdone.graphql.endpoint, {
    headers: {
        authorization: appConfig.jobdone.auth.bearerToken,
        organization: appConfig.jobdone.organization.id,
    },
});

export const refreshBearerToken = async (refreshToken: string): Promise<AuthTokens> => {
    const command = new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: appConfig.jobdone.auth.userPoolWebClientId,
        AuthParameters: {
            REFRESH_TOKEN: refreshToken
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
            idToken: '',
            refreshToken: '',
        };
    }
    const srpSession = createSrpSession(appConfig.jobdone.auth.username, appConfig.jobdone.auth.password, appConfig.jobdone.auth.userPoolId, false);
    const command = new InitiateAuthCommand(wrapInitiateAuth(srpSession, {
        AuthFlow: "USER_SRP_AUTH",
        ClientId: appConfig.jobdone.auth.userPoolWebClientId,
        AuthParameters: {
            CHALLENGE_NAME: "SRP_A",
            USERNAME: appConfig.jobdone.auth.username,
        },
    }));

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
                }),
            ),
        )

        logger.info(`Authentication successful: ${JSON.stringify(response, null, 2)}`);
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

export const getCostCenters = async (): => {
    const result : CostCenterByOrganizationIdQuery = await internalGraphqlClient.request(
        CostCenterByOrganizationId,
        {
            organizationId: appConfig.jobdone.organization.id,
        }
    );

    // return costCenterMatchField as key, and id as value, as Set
    return result.costCenter.reduce((acc, curr) => {
        acc[curr[appConfig.importer.costCenterMatchField]] = curr.id;
        return acc;
    }, {});
}

export const getMetricTypes = async () => {
    const result : MetricTypeByOrganizationIdQuery = await internalGraphqlClient.request(
        MetricTypeByOrganizationId,
        {
            organizationId: appConfig.jobdone.organization.id,
        }
    );

    // metric type name as key, and id as value, as Set
    return result.metricType.reduce((acc, curr) => {
        acc[curr.name] = curr.id;
        return acc;
    }, {});
}

export const saveMetric = async(data: Metric) => {
    const saveMetricMutationVariables: SaveMetricMutationVariables = {
        input: {
            details: {
                costCenterId: data.costCenterId,
                description: data.description,
                field: data.field,
                metricTypeId: data.metricTypeId,
                timeZone: appConfig.importer.timeZone,
                timestamp:  data.timestamp,
                value: data.value,
            }
        }

    }

    const result = await externalGraphqlClient.request<
        SaveMetricMutation,
        SaveMetricMutationVariables
    >(SaveMetric, saveMetricMutationVariables);

}

