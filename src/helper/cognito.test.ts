import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { setRequiredEnvForConfig } from "../test-utils/mocks";

const sendMock = mock(async () => ({}));

beforeAll(() => {
  setRequiredEnvForConfig();

  mock.module("cognito-srp-helper", () => ({
    createSrpSession: () => ({}),
    signSrpSession: () => ({}),
    wrapAuthChallenge: (_session: unknown, payload: unknown) => payload,
    wrapInitiateAuth: (_session: unknown, payload: unknown) => payload,
  }));

  class FakeCognitoIdentityProviderClient {
    send = sendMock;
    constructor(_: unknown) {}
  }

  class FakeInitiateAuthCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class FakeRespondToAuthChallengeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  mock.module("@aws-sdk/client-cognito-identity-provider", () => ({
    CognitoIdentityProviderClient: FakeCognitoIdentityProviderClient,
    InitiateAuthCommand: FakeInitiateAuthCommand,
    RespondToAuthChallengeCommand: FakeRespondToAuthChallengeCommand,
  }));
});

beforeEach(() => {
  sendMock.mockReset();
});

afterAll(() => {
  mock.restore();
});

describe("cognito helper", () => {
  it("refreshes bearer token", async () => {
    sendMock.mockImplementationOnce(async () => ({
      AuthenticationResult: {
        AccessToken: "access-1",
        IdToken: "id-1",
        RefreshToken: "refresh-1",
      },
    }));

    const cognito = await import("./cognito.ts?case=refresh");
    const result = await cognito.refreshBearerToken("refresh-token");

    expect(result).toEqual({
      accessToken: "access-1",
      idToken: "id-1",
      refreshToken: "refresh-1",
    });
  });

  it("authenticates and returns token trio", async () => {
    sendMock.mockImplementationOnce(async () => ({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: {},
    }));
    sendMock.mockImplementationOnce(async () => ({
      AuthenticationResult: {
        AccessToken: "access-2",
        IdToken: "id-2",
        RefreshToken: "refresh-2",
      },
    }));

    const cognito = await import("./cognito.ts?case=authenticate");
    const result = await cognito.authenticate();

    expect(result).toEqual({
      accessToken: "access-2",
      idToken: "id-2",
      refreshToken: "refresh-2",
    });
  });
});
