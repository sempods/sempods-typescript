// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownView } from './markdown-view.js';

afterEach(cleanup);

it('renders paragraphs, headings, lists and emphasis', () => {
  const { container } = render(
    <MarkdownView
      source={
        '# Plan\n\nFirst **bold** and *italic*,\nthen a line.\n\n## Steps\n\n- one\n- two\n\n1. first\n2. second'
      }
    />,
  );
  expect(screen.getByRole('heading', { level: 3, name: 'Plan' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 4, name: 'Steps' })).toBeTruthy();
  expect(container.querySelector('strong')?.textContent).toBe('bold');
  expect(container.querySelector('em')?.textContent).toBe('italic');
  // A typed line break shows as one.
  const paragraph = container.querySelector('p');
  expect(paragraph?.querySelectorAll('br')).toHaveLength(1);
  expect(paragraph?.textContent).toContain(',\nthen');
  expect(container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(container.querySelectorAll('ol > li')).toHaveLength(2);
});

it('strikes text through between two tildes, not one', () => {
  const { container } = render(
    <MarkdownView source={'~~gone~~ and ~one~ and \\~~kept~~'} />,
  );
  expect(
    [...container.querySelectorAll('del')].map((d) => d.textContent),
  ).toEqual(['gone']);
  expect(container.textContent).toBe('gone and ~one~ and ~~kept~~');
});

it('shows spaces at a line start, as the writer keeps them', () => {
  const { container } = render(
    <MarkdownView source={'&#32;&#32;&#32;&#32;test\\\n&#32;&#32;next'} />,
  );
  expect(container.querySelector('p')?.textContent).toBe(
    '\u00a0\u00a0\u00a0\u00a0test\n\u00a0\u00a0next',
  );
});

it('shows spaces at a line start inside emphasis', () => {
  const { container } = render(
    <MarkdownView source={'**First\\\n&#32;&#32;Second**'} />,
  );
  expect(container.querySelector('strong')?.textContent).toBe(
    'First\n\u00a0\u00a0Second',
  );
});

it('shows a link over two lines as one link', () => {
  render(<MarkdownView source={'[First\\\nSecond](https://a.b)'} />);
  expect(screen.getAllByRole('link')).toHaveLength(1);
});

it('shows a link over a formatting boundary as one link', () => {
  render(<MarkdownView source="**Visit** [**our** website](https://a.b)" />);
  const links = screen.getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual(['our website']);
});

it('shows a hard line break as one break, as a typed one', () => {
  const { container } = render(
    <MarkdownView
      source={'hard  \nbreak\n\nsoft\nbreak\n\nboth\\\nand\nmore'}
    />,
  );
  const breaks = [...container.querySelectorAll('p')].map(
    (p) => p.querySelectorAll('br').length,
  );
  expect(breaks).toEqual([1, 1, 2]);
  for (const p of container.querySelectorAll('p'))
    expect(getComputedStyle(p).whiteSpace).not.toMatch(/pre/);
});

it('starts headings at the given level and stops at h6', () => {
  render(<MarkdownView source={'# One\n\n###### Six'} headingLevel={2} />);
  expect(screen.getByRole('heading', { level: 2, name: 'One' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 6, name: 'Six' })).toBeTruthy();
});

it('links only web addresses, opening them in a new tab', () => {
  const { container } = render(
    <MarkdownView
      source={
        '[web](https://example.org/a) [plain](http://example.org) [script](javascript:alert(1)) [mail](mailto:a@example.org) [here](/relative)'
      }
    />,
  );
  const links = [...container.querySelectorAll('a')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual([
    'https://example.org/a',
    'http://example.org',
  ]);
  for (const a of links) {
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
  }
  expect(container.textContent).toContain('script');
  expect(container.textContent).toContain('mail');
  expect(container.textContent).toContain('here');
});

it('links an address in angle brackets as the field writes it', () => {
  const { container } = render(
    <MarkdownView source="[page](<https://example.org/a)b>)" />,
  );
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    'https://example.org/a)b',
  );
});

it('links labels as the field escapes them', () => {
  const { container } = render(
    <MarkdownView
      source={
        '[💰 price \\[USD](https://example.org/a) [C:\\folder\\\\](https://example.org/b)'
      }
    />,
  );
  expect(
    [...container.querySelectorAll('a')].map((a) => a.textContent),
  ).toEqual(['💰 price [USD', 'C:\\folder\\']);
});

it('shows embedded HTML as text and images only as their description', () => {
  const { container } = render(
    <MarkdownView
      source={
        '<img src="https://tracker.example/pixel.gif">\n\n![A cat](https://example.org/cat.png)\n\n<script>alert(1)</script> <b>no</b>'
      }
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('b')).toBeNull();
  expect(container.textContent).toContain(
    '<img src="https://tracker.example/pixel.gif">',
  );
  expect(container.textContent).toContain('A cat');
  expect(container.textContent).toContain('<b>no</b>');
  expect(container.innerHTML).not.toContain('cat.png');
});
