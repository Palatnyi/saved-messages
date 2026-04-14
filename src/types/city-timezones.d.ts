declare module "city-timezones" {
  export interface CityData {
    city: string;
    city_ascii: string;
    lat: number;
    lng: number;
    pop: number;
    country: string;
    iso2: string;
    iso3: string;
    province: string;
    timezone: string;
  }

  export function lookupViaCity(city: string): CityData[];
  export function findFromCityStateProvince(query: string): CityData[];
  export const cityMapping: CityData[];
}
