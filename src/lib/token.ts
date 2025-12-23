const ELEVENLABS_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'

export interface TokenResponse {
  token: string
}

export interface TokenError {
  detail?: string
  message?: string
}

export async function fetchToken(apiKey: string): Promise<string> {
  if (!apiKey) {
    console.error('[Token] No API key provided')
    throw new Error('API key is required')
  }

  console.log('[Token] Fetching token from:', ELEVENLABS_TOKEN_URL)

  try {
    const response = await fetch(ELEVENLABS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    })

    console.log('[Token] Response status:', response.status)

    if (!response.ok) {
      const errorData: TokenError = await response.json().catch(() => ({}))
      const errorMessage = errorData.detail || errorData.message || `HTTP ${response.status}`
      console.error('[Token] Error response:', errorData)
      throw new Error(`Failed to fetch token: ${errorMessage}`)
    }

    const data: TokenResponse = await response.json()
    console.log('[Token] Token received, length:', data.token?.length)
    
    if (!data.token) {
      throw new Error('No token received from API')
    }

    return data.token
  } catch (error) {
    console.error('[Token] Fetch error:', error)
    throw error
  }
}





