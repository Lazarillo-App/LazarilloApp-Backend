// controllers/placesController.js
//
// Proxy hacia Google Places API (New) + Geocoding API, para la búsqueda de
// negocio del asistente de onboarding (reemplaza la búsqueda por IA:
// más preciso, más rápido, y no consume tokens de Anthropic). La key vive
// solo acá (env GOOGLE_MAPS_API_KEY), nunca en el browser.

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// Campos pedidos a Places (New) — cuantos menos, más barato el llamado.
// Necesitamos nombre/dirección/teléfono/sitio/ubicación para precargar
// DatosNegocio en el asistente.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
].join(',');

function pickComponent(components, types) {
  for (const t of types) {
    const c = (components || []).find((x) => (x.types || []).includes(t));
    if (c) return c.longText || c.shortText || '';
  }
  return '';
}

function mapPlace(p) {
  const comps = p.addressComponents || [];
  return {
    placeId: p.id || '',
    nombre: p.displayName?.text || '',
    ciudad: pickComponent(comps, ['locality', 'sublocality', 'administrative_area_level_2', 'administrative_area_level_1']),
    calle: pickComponent(comps, ['route']),
    numero: pickComponent(comps, ['street_number']),
    telefono: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    descripcion: '',
    web: p.websiteUri || '',
    instagram: '', facebook: '', tiktok: '',
    logos: [],
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    direccion: p.formattedAddress || '',
  };
}

// GET /api/places/search?q=...&lat=...&lng=...
exports.search = async (req, res) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      console.error('[places/search] falta GOOGLE_MAPS_API_KEY');
      return res.status(500).json({ error: 'places_not_configured' });
    }
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing_query' });

    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lng = req.query.lng != null ? Number(req.query.lng) : null;

    const body = {
      textQuery: q,
      languageCode: 'es',
      regionCode: 'AR',
      maxResultCount: 8,
    };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      // Sesga (no filtra) hacia lo más cercano a esas coordenadas.
      body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 15000 } };
    }

    const resp = await fetch(PLACES_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[places/search] error:', resp.status, detail.slice(0, 400));
      return res.status(502).json({ error: 'places_upstream_error' });
    }

    const data = await resp.json();
    const opciones = (data.places || []).map(mapPlace).filter((o) => o.nombre);
    res.json({ opciones });
  } catch (e) {
    console.error('[places/search] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

// GET /api/places/geocode?text=... — coordenadas aproximadas de una zona/ciudad
// escrita a mano (cuando no hay GPS), para sesgar la búsqueda de arriba.
exports.geocode = async (req, res) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: 'places_not_configured' });
    }
    const text = String(req.query.text || '').trim();
    if (!text) return res.status(400).json({ error: 'missing_text' });

    const url = `${GEOCODE_URL}?address=${encodeURIComponent(text)}&key=${process.env.GOOGLE_MAPS_API_KEY}&language=es&region=ar`;
    const resp = await fetch(url);
    if (!resp.ok) return res.status(502).json({ error: 'places_upstream_error' });
    const data = await resp.json();
    const first = (data.results || [])[0];
    if (!first) return res.json({ lat: null, lng: null, zona: text });
    const loc = first.geometry?.location || {};
    res.json({ lat: loc.lat ?? null, lng: loc.lng ?? null, zona: first.formatted_address || text });
  } catch (e) {
    console.error('[places/geocode] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
