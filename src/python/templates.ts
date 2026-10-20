/** Starter files offered by "New file". Short, runnable, and each shows one idea. */
export interface Template {
  id: string;
  label: string;
  description: string;
  filename: string;
  content: string;
}

export const TEMPLATES: Template[] = [
  { id: 'blank', label: 'Blank file', description: 'An empty Python file', filename: 'untitled.py', content: '' },
  {
    id: 'hello',
    label: 'Hello, world',
    description: 'The classic first program',
    filename: 'main.py',
    content: `def main():
    print("Hello from PyForge!")


if __name__ == "__main__":
    main()
`,
  },
  {
    id: 'input',
    label: 'Ask for input',
    description: 'Read text typed in the console',
    filename: 'greeter.py',
    content: `name = input("What's your name? ")
age = int(input("How old are you? "))

print(f"Nice to meet you, {name}!")
print(f"In 10 years you'll be {age + 10}.")
`,
  },
  {
    id: 'turtle',
    label: 'Turtle graphics',
    description: 'Draw a colourful spiral',
    filename: 'spiral.py',
    content: `import turtle

screen = turtle.Screen()
screen.bgcolor("black")
screen.title("Spiral")

t = turtle.Turtle()
t.speed(0)
t.hideturtle()

colors = ["red", "orange", "yellow", "lime", "cyan", "violet"]
for i in range(180):
    t.pencolor(colors[i % len(colors)])
    t.forward(i * 1.6)
    t.left(59)

turtle.done()
`,
  },
  {
    id: 'plot',
    label: 'Plot with matplotlib',
    description: 'Needs the matplotlib package',
    filename: 'plot.py',
    content: `import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 2 * np.pi, 200)
plt.plot(x, np.sin(x), label="sin")
plt.plot(x, np.cos(x), label="cos")
plt.legend()
plt.title("Sine and cosine")
plt.show()
`,
  },
  {
    id: 'requests',
    label: 'Fetch a web page',
    description: 'Needs the requests package',
    filename: 'fetch.py',
    content: `import requests

response = requests.get("https://httpbin.org/json", timeout=10)
print(response.status_code)
print(response.json())
`,
  },
];

export const DEFAULT_FILE = TEMPLATES.find((t) => t.id === 'hello')!;
