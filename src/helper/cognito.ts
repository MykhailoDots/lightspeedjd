import {
  createSrpSession,
  signSrpSession,
  wrapAuthChallenge,
  wrapInitiateAuth,
} from "cognito-srp-helper";
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { appEnvironment } from "../config";
import logger from "./logger";

export interface AuthTokens {
  accessToken: string | undefined;
  idToken: string | undefined;
  refreshToken: string | undefined;
}

export const client = new CognitoIdentityProviderClient({
  region: appEnvironment.auth.authRegion,
});

export const refreshBearerToken = async (
  refreshToken: string
): Promise<AuthTokens> => {
  const command = new InitiateAuthCommand({
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: appEnvironment.auth.userPoolWebClientId,
    AuthParameters: {
      REFRESH_TOKEN: refreshToken,
    },
  });

  try {
    const response = await client.send(command);
    logger.info("Token refresh successful!", response);
    return {
      accessToken: response.AuthenticationResult?.AccessToken,
      idToken: response.AuthenticationResult?.IdToken,
      refreshToken: response.AuthenticationResult?.RefreshToken,
    };
  } catch (error) {
    logger.error("Token refresh failed:", error);
    throw error;
  }
};

export const authenticate = async (): Promise<AuthTokens> => {
  // if (appEnvironment.auth.bearerToken) {
  //   return {
  //     accessToken: appEnvironment.auth.bearerToken,
  //     idToken: "",
  //     refreshToken: "",
  //   };
  // }
  const srpSession = createSrpSession(
    appEnvironment.auth.username,
    appEnvironment.auth.password,
    appEnvironment.auth.userPoolId,
    false
  );
  const command = new InitiateAuthCommand(
    wrapInitiateAuth(srpSession, {
      AuthFlow: "USER_SRP_AUTH",
      ClientId: appEnvironment.auth.userPoolWebClientId,
      AuthParameters: {
        CHALLENGE_NAME: "SRP_A",
        USERNAME: appEnvironment.auth.username,
      },
    })
  );

  try {
    const initiateAuthRes = await client.send(command);
    const signedSrpSession = signSrpSession(srpSession, initiateAuthRes);
    const response = await client.send(
      new RespondToAuthChallengeCommand(
        wrapAuthChallenge(signedSrpSession, {
          ClientId: appEnvironment.auth.userPoolWebClientId,
          ChallengeName: "PASSWORD_VERIFIER",
          ChallengeResponses: {
            USERNAME: appEnvironment.auth.username,
          },
        })
      )
    );

    logger.info(
      `Authentication successful: ${JSON.stringify(response, null, 2)}`
    );
    return {
      accessToken: response.AuthenticationResult?.AccessToken,
      idToken: response.AuthenticationResult?.IdToken,
      refreshToken: response.AuthenticationResult?.RefreshToken,
    };
  } catch (error) {
    logger.error(`Authentication failed: ${JSON.stringify(error, null, 2)}`);
    throw error;
  }
};
