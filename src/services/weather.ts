const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";

function wmoToEmoji(code: number): string {
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code === 85 || code === 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

export interface WeatherInfo {
  tempC: number;
  emoji: string;
}

export async function getWeatherForCity(city: string): Promise<WeatherInfo | null> {
  try {
    const geoRes = await fetch(`${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`);
    if (!geoRes.ok) return null;
    const geoData = await geoRes.json() as { results?: { latitude: number; longitude: number }[] };
    const loc = geoData.results?.[0];
    if (!loc) return null;

    const weatherRes = await fetch(
      `${WEATHER_URL}?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&timezone=auto`
    );
    if (!weatherRes.ok) return null;
    const weatherData = await weatherRes.json() as {
      current?: { temperature_2m: number; weather_code: number };
    };
    const current = weatherData.current;
    if (!current) return null;

    return {
      tempC: Math.round(current.temperature_2m),
      emoji: wmoToEmoji(current.weather_code),
    };
  } catch (err) {
    console.warn("[weather] failed to fetch weather for", city, err);
    return null;
  }
}
