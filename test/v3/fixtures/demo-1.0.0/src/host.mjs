const FORECAST = "https://api.open-meteo.com/v1/forecast";

export default function demo(ctx) {
  ctx.provide("demo-weather", {
    async current(lat, lon) {
      const response = await fetch(`${FORECAST}?latitude=${lat}&longitude=${lon}&current=weather_code`);
      return response.ok ? (await response.json()).current : null;
    },
  });
}
