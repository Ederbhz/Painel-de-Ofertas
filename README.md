# Painel de Ofertas

Painel responsivo para analisar oportunidades do Mercado Livre para o Ofertas 360.

Site publicado:

https://ederbhz.github.io/Painel-de-Ofertas/

## Atualização automática

O arquivo `ofertas.json` é gerado pelo GitHub Actions em `.github/workflows/atualizar-ofertas.yml`.

O workflow roda:

- todos os dias às 07:00 e 15:00 no horário de Brasília;
- manualmente pelo botão **Run workflow** na aba **Actions**;
- quando o script de atualização for alterado.

Por padrão, o script tenta usar a API pública do Mercado Livre. Caso a API exija autenticação ou limite chamadas, crie um secret no repositório chamado `MELI_ACCESS_TOKEN`. O token fica salvo apenas no GitHub Actions e não é exposto no HTML.
