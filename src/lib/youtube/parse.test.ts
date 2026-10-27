import { describe, expect, it } from 'vitest'
import { parseVideoId } from './parse'

describe('parseVideoId', () => {
  const id = 'dQw4w9WgXcQ'
  it.each([
    [id, id],
    [`  ${id}\n`, id],
    [`https://www.youtube.com/watch?v=${id}`, id],
    [`https://youtube.com/watch?v=${id}&t=42s&list=PL123`, id],
    [`https://m.youtube.com/watch?feature=share&v=${id}`, id],
    [`https://music.youtube.com/watch?v=${id}`, id],
    [`youtube.com/watch?v=${id}`, id],
    [`https://youtu.be/${id}`, id],
    [`https://youtu.be/${id}?t=10`, id],
    [`https://www.youtube.com/embed/${id}`, id],
    [`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`, id],
    [`https://www.youtube.com/shorts/${id}`, id],
    [`https://www.youtube.com/live/${id}?feature=share`, id],
    [`https://www.youtube.com/v/${id}`, id],
  ])('розпізнає %s', (input, expected) => {
    expect(parseVideoId(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'abc',
    'https://vimeo.com/123456',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'not a url at all with spaces',
  ])('відхиляє %j', (input) => {
    expect(parseVideoId(input)).toBeNull()
  })
})
