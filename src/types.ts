import {appConfig} from "./config.ts";

export interface MetricCSVImport {
    date: string;
    costCenter: string;
    metricType: string;
    value: string;
}

export interface GroupedMetric {
    date: string;
    costCenter: string;
    metricType: string;
    value: number;
}

export interface Metric {
    costCenterId: string;
    description: string;
    field: string;
    metricTypeId: string;
    timeZone: string;
    timestamp: string;
    value: number;
}


export interface MetricTypeMapping {
    importName: string;
    jobdoneName: string;
}

export interface AuthTokens {
    accessToken: string | undefined;
    idToken: string | undefined
    refreshToken: string | undefined
}